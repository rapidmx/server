///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { setDraining as markDraining } from "../plugins/readiness.js";

/** How long giving back shared state (the plugin restart lock) may take during shutdown - see `withTimeout()`. */
export const DEFAULT_RELEASE_TIMEOUT_MS = 5_000;

/**
 * Waits for `promise`, at most `timeoutMs`: `"done"` when it settled (a rejection counts - the caller only wants it
 * out of the way), `"timeout"` otherwise. The promise keeps running in the background.
 */
export async function withTimeout(promise: Promise<unknown>, timeoutMs: number): Promise<"done" | "timeout"> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
        timer.unref?.();
    });
    const settled: Promise<"done"> = promise.then(
        () => "done" as const,
        () => "done" as const,
    );
    try {
        return await Promise.race([settled, timeout]);
    } finally {
        clearTimeout(timer);
    }
}

export interface DrainAndStopOptions {
    /** How long to report not ready (GET /api/status answers 503) before stopping, so load balancers stop routing here. */
    drainDelayMs: number;
    /** How long stopping may take before giving up. */
    timeoutMs: number;
    logger?: { info(msg: string): void; error(msg: string): void };
    /**
     * Runs first, before draining - e.g. giving back the plugin restart lock. Bounded by `releaseTimeoutMs`, since it
     * talks to Redis: with Redis down, node-redis queues `quit()` until it reconnects, which would otherwise hang the
     * shutdown until the container is killed.
     */
    release?: () => Promise<void>;
    /** How long `release` may take before shutdown carries on without it. Default 5 s. */
    releaseTimeoutMs?: number;
    /** Replaceable for tests. */
    setDraining?: (value: boolean) => void;
    sleep?: (ms: number) => Promise<void>;
}

/**
 * Stops the server gracefully: marks this process as draining so the readiness probe fails and no new requests are
 * routed here, waits `drainDelayMs` for in-flight requests to finish and load balancers to notice, then runs `stop`,
 * giving up after `timeoutMs` so a hung stop (e.g. a database connection that never closes) can't keep the process
 * alive past the container's grace period.
 *
 * @returns `"stopped"` when `stop` completed, `"failed"` when it threw, `"timeout"` when it didn't finish in time.
 */
export async function drainAndStop(stop: () => Promise<void>, options: DrainAndStopOptions): Promise<"stopped" | "failed" | "timeout"> {
    const { drainDelayMs, timeoutMs, logger } = options;
    const setDraining = options.setDraining ?? markDraining;
    const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

    if (options.release) {
        const released = await withTimeout(options.release(), options.releaseTimeoutMs ?? DEFAULT_RELEASE_TIMEOUT_MS);
        if (released === "timeout") {
            logger?.error(
                `Releasing shared state (e.g. the plugin restart lock) took longer than ${Math.round((options.releaseTimeoutMs ?? DEFAULT_RELEASE_TIMEOUT_MS) / 1000)}s; stopping anyway.`,
            );
        }
    }

    setDraining(true);
    if (drainDelayMs > 0) {
        logger?.info(`Draining for ${Math.round(drainDelayMs / 1000)}s before stopping...`);
        await sleep(drainDelayMs);
    }

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
        timer.unref?.();
    });
    const stopped: Promise<"stopped" | "failed"> = stop().then(
        () => "stopped" as const,
        (err: any) => {
            logger?.error(`The server didn't stop cleanly: ${err?.message ?? err}`);
            return "failed" as const;
        },
    );
    const result = await Promise.race([stopped, timeout]);
    clearTimeout(timer);
    if (result === "timeout") {
        logger?.error(`Stopping the server took longer than ${Math.round(timeoutMs / 1000)}s; exiting anyway.`);
    }
    return result;
}

/** A non-negative number of milliseconds from config, or `fallback`. */
export function configMs(value: unknown, fallback: number): number {
    const ms: number = Number(value);
    return value !== undefined && value !== null && value !== "" && Number.isFinite(ms) && ms >= 0 ? ms : fallback;
}
