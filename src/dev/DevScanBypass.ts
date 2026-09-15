///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import * as net from "net";
import { ObjectDecorators } from "@rapidrest/core";
import { AvVerdict, SpamVerdict } from "@rapidmx/restapi";
import {
    ClamAvScanProvider,
    RspamdSpamScanProvider,
    type AvScanProvider,
    type AvScanResult,
    type ScanEnvelope,
    type SpamScanProvider,
    type SpamScanResult,
} from "@rapidmx/restapi/scan";
const { Config, Inject, Logger } = ObjectDecorators;

/**
 * Error codes meaning a scan engine couldn't be reached at all: nothing listening, a name that doesn't resolve, no route
 * to it, or a connection that timed out. Anything else (a reset after connecting, a TLS or protocol failure) is not an
 * outage of this kind and is never bypassed.
 */
const UNREACHABLE_ERROR_CODES: ReadonlySet<string> = new Set([
    "ECONNREFUSED",
    "ENOTFOUND",
    "EAI_AGAIN",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "EADDRNOTAVAIL",
    "ETIMEDOUT",
]);

/** The command that starts the development scanning stack, named in the bypass warning. */
export const DEV_SCANNING_STACK_COMMAND = "docker compose -f docker-compose.mail.yml up -d";

/** The outcome of `probeScanEngine()`. */
export type ScanEngineProbe = { reachable: true } | { reachable: false; reason: string };

/** `true` when `err` (or the error it wraps, as `fetch()` does) means the engine couldn't be connected to at all. */
export function isEngineUnreachableError(err: any): boolean {
    return UNREACHABLE_ERROR_CODES.has(err?.code) || UNREACHABLE_ERROR_CODES.has(err?.cause?.code);
}

/**
 * Opens and immediately closes a TCP connection to a scan engine. Resolves `{ reachable: false }` when the connection
 * fails for one of the reasons `isEngineUnreachableError()` accepts or doesn't complete within `timeoutMs`, and
 * `{ reachable: true }` once it connects. Any other connection error rejects.
 */
export function probeScanEngine(host: string, port: number, timeoutMs: number): Promise<ScanEngineProbe> {
    return new Promise((resolve, reject) => {
        const socket: net.Socket = net.createConnection({ host, port });
        let settled: boolean = false;
        const settle = (finish: () => void): void => {
            if (!settled) {
                settled = true;
                socket.destroy();
                finish();
            }
        };
        socket.setTimeout(timeoutMs, () =>
            settle(() => resolve({ reachable: false, reason: `timed out connecting after ${timeoutMs} ms` })),
        );
        socket.on("connect", () => settle(() => resolve({ reachable: true })));
        socket.on("error", (err: NodeJS.ErrnoException) =>
            settle(() => (isEngineUnreachableError(err) ? resolve({ reachable: false, reason: err.message }) : reject(err))),
        );
    });
}

/**
 * DEV-ONLY. The shared logic of `DevBypassSpamScanProvider` and `DevBypassAvScanProvider`, which wrap the real rspamd and
 * ClamAV providers under a development `NODE_ENV` so composing and sending mail works without docker-compose.mail.yml's
 * scanning stack running. Registered only by `registerMailProviders()` for `dev`/`development`/`test`; every other
 * `NODE_ENV` registers the real providers directly and keeps failing closed on a scan-engine outage.
 *
 * The real providers never throw on an outage: they log and return their fail-closed result (`AvVerdict.ERROR`, or
 * `SpamVerdict.SUSPECT` with `SCAN_ENGINE_UNAVAILABLE`), the same result a protocol error after connecting gives. So when
 * a scan comes back with that result, the engine is probed with a plain TCP connect: only if it can't be reached at all
 * is the scan treated as clean. A reachable engine's results, fail-closed ones included, are returned unchanged, and an
 * error the real provider throws still propagates.
 *
 * While an engine is known to be unreachable, scans are bypassed without calling it, and it's probed again every
 * `recheckMs`. The warning is logged the first time a scan is bypassed and then at most every `warnIntervalMs`, with
 * the number of scans bypassed since the last one, rather than once per message.
 */
export abstract class DevScanBypass {
    /** How long an engine found unreachable is bypassed before it's probed again. */
    public recheckMs: number = 30_000;
    /** The minimum time between two bypass warnings for the same engine. */
    public warnIntervalMs: number = 5 * 60_000;
    /** How long the reachability probe waits for a connection. */
    public probeTimeoutMs: number = 2_000;
    /** The clock, replaceable in tests. */
    public now: () => number = () => Date.now();

    @Logger
    protected logger: any;

    /** When set, the engine was unreachable at the last probe and scans are bypassed until this time. */
    private unreachableUntil?: number;
    private lastReason: string = "";
    private lastWarnedAt?: number;
    private bypassedSinceWarning: number = 0;

    /** The engine's name in log messages, e.g. `"ClamAV"`. */
    protected abstract readonly engineLabel: string;
    /** What is bypassed, for the warning, e.g. `"virus scanning (messages are treated as clean)"`. */
    protected abstract readonly bypassDescription: string;
    /** Where the real provider connects to. */
    protected abstract engineAddress(): { host: string; port: number };

    /**
     * Runs `scan` unless the engine is known to be unreachable, returning its result unchanged unless `isOutage()`
     * says it's the provider's fail-closed outage result and a probe finds the engine unreachable, in which case
     * `bypassed()` is returned instead.
     */
    protected async guard<R>(scan: () => Promise<R>, isOutage: (result: R) => boolean, bypassed: () => R): Promise<R> {
        if (this.unreachableUntil !== undefined) {
            if (this.now() < this.unreachableUntil) {
                return this.bypass(bypassed);
            }
            const probe: ScanEngineProbe = await this.probe();
            if (!probe.reachable) {
                return this.bypass(bypassed, probe.reason);
            }
            const { host, port } = this.engineAddress();
            this.unreachableUntil = undefined;
            this.lastWarnedAt = undefined;
            this.bypassedSinceWarning = 0;
            this.logger?.warn(`[dev] ${this.engineLabel} at ${host}:${port} is reachable again; scanning is no longer bypassed.`);
        }

        const result: R = await scan();
        if (!isOutage(result)) {
            return result;
        }
        const probe: ScanEngineProbe = await this.probe();
        return probe.reachable ? result : this.bypass(bypassed, probe.reason);
    }

    /** Probes the engine. An unexpected probe error counts as reachable, so the real (fail-closed) result is kept. */
    private async probe(): Promise<ScanEngineProbe> {
        const { host, port } = this.engineAddress();
        try {
            return await probeScanEngine(host, port, this.probeTimeoutMs);
        } catch (err: any) {
            this.logger?.debug(`[dev] ${this.engineLabel} probe of ${host}:${port} failed without an outage: ${err?.message}`);
            return { reachable: true };
        }
    }

    /** Returns `bypassed()`, recording a new unreachable probe (`reason`) and logging the throttled warning. */
    private bypass<R>(bypassed: () => R, reason?: string): R {
        const now: number = this.now();
        if (reason !== undefined) {
            this.unreachableUntil = now + this.recheckMs;
            this.lastReason = reason;
        }
        this.bypassedSinceWarning++;
        if (this.lastWarnedAt === undefined || now - this.lastWarnedAt >= this.warnIntervalMs) {
            const { host, port } = this.engineAddress();
            const count: string =
                this.bypassedSinceWarning === 1 ? "" : ` (${this.bypassedSinceWarning} scans bypassed since the last warning)`;
            this.logger?.warn(
                `[dev] ${this.engineLabel} at ${host}:${port} is unreachable (${this.lastReason}), so ${this.bypassDescription}${count}. ` +
                    `The development scanning stack isn't running: start it with \`${DEV_SCANNING_STACK_COMMAND}\`. ` +
                    "This only happens with NODE_ENV dev/development/test; any other NODE_ENV fails closed.",
            );
            this.lastWarnedAt = now;
            this.bypassedSinceWarning = 0;
        }
        return bypassed();
    }
}

/** DEV-ONLY: `RspamdSpamScanProvider`, with an unreachable rspamd treated as not spam. See `DevScanBypass`. */
export class DevBypassSpamScanProvider extends DevScanBypass implements SpamScanProvider {
    public readonly name: string = "rspamd";
    protected readonly engineLabel: string = "rspamd";
    protected readonly bypassDescription: string = "spam scoring is bypassed and messages are treated as not spam";

    @Inject(RspamdSpamScanProvider)
    private inner?: SpamScanProvider;

    // The same key and default `RspamdSpamScanProvider` connects to.
    @Config("mail:scan:spam:rspamd:url", "http://127.0.0.1:11333")
    private url: string = "http://127.0.0.1:11333";

    public async scoreMessage(raw: Buffer, envelope: ScanEnvelope): Promise<SpamScanResult> {
        const inner: SpamScanProvider = requireInner(this.inner, "RspamdSpamScanProvider");
        return this.guard(
            () => inner.scoreMessage(raw, envelope),
            (result) => result.verdict === SpamVerdict.SUSPECT && result.symbols.includes("SCAN_ENGINE_UNAVAILABLE"),
            () => ({ score: 0, verdict: SpamVerdict.CLEAN, symbols: ["DEV_SCAN_BYPASSED"] }),
        );
    }

    protected engineAddress(): { host: string; port: number } {
        const url: URL = new URL(this.url);
        return {
            host: url.hostname.replace(/^\[(.*)\]$/, "$1"),
            port: url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80,
        };
    }
}

/** DEV-ONLY: `ClamAvScanProvider`, with an unreachable clamd treated as clean. See `DevScanBypass`. */
export class DevBypassAvScanProvider extends DevScanBypass implements AvScanProvider {
    public readonly name: string = "clamav";
    protected readonly engineLabel: string = "ClamAV (clamd)";
    protected readonly bypassDescription: string = "virus scanning is bypassed and content is treated as clean";

    @Inject(ClamAvScanProvider)
    private inner?: AvScanProvider;

    // The same keys and defaults `ClamAvScanProvider` connects to.
    @Config("mail:scan:av:clamav:host", "127.0.0.1")
    private host: string = "127.0.0.1";

    @Config("mail:scan:av:clamav:port", 3310)
    private port: number = 3310;

    public async scanBuffer(content: Buffer, filename?: string): Promise<AvScanResult> {
        const inner: AvScanProvider = requireInner(this.inner, "ClamAvScanProvider");
        return this.guard(
            () => inner.scanBuffer(content, filename),
            (result) => result.verdict === AvVerdict.ERROR,
            () => ({ verdict: AvVerdict.CLEAN }),
        );
    }

    protected engineAddress(): { host: string; port: number } {
        return { host: this.host, port: Number(this.port) };
    }
}

function requireInner<T>(inner: T | undefined, className: string): T {
    if (!inner) {
        throw new Error(`The development scan bypass has no ${className} to wrap.`);
    }
    return inner;
}
