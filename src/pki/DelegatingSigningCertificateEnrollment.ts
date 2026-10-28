///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { createHash } from "crypto";
import { ObjectDecorators } from "@rapidrest/core";
import {
    ManualSigningCertificateEnrollment,
    NullSigningCertificateEnrollment,
    Rfc8823AcmeSigningCertificateEnrollment,
    type SigningCertificateEnrollment,
} from "@rapidmx/restapi";
import { liveConfig } from "../integrations/liveConfig.js";
const { Config, Init, Logger } = ObjectDecorators;

/** Which signing-certificate backend serves new enrollments, and for the RFC 8823 one which CA and contact it is built for. */
export interface SigningBackendKey {
    kind: "manual" | "rfc8823" | "none";
    directoryUrl?: string;
    contactEmail?: string;
}

/** What only the backend in force answers: who it is, what it reports about itself, and where a new enrollment starts. */
const ACTIVE_ONLY: ReadonlySet<string> = new Set(["name", "kind", "describeBackend", "startEnrollment"]);

/** The members whose first argument is an enrollment id: they go to the backend that knows the id, wherever it started. */
const BY_ENROLLMENT: ReadonlySet<string> = new Set([
    "checkStatus",
    "describeEnrollment",
    "describeProgress",
    "checkNow",
    "cancelEnrollment",
    "attachWrappedKey",
    "advanceEnrollment",
    "getIssuedMaterial",
    "markInstalled",
    "markFailed",
    "recordChallengeToken",
    "getRequest",
    "uploadValidatedCertificate",
    "uploadCertificate",
    "rejectEnrollment",
]);

/** The listings: the enrollments of every backend this process has used, so the background job still drives and the key vault still sees one in flight. */
const AGGREGATED: ReadonlySet<string> = new Set(["listPendingEnrollments", "listEnrollments", "listAdminEnrollments"]);

/** A non-empty text setting, or `undefined`. */
function text(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/**
 * The `SigningCertificateEnrollment` the server registers (restapi spec 11.3). Which backend serves is chosen from `mail:pki:signing_enrollment:backend` at
 * each enrollment start, read through the integrations layer, so the backend an administrator picks in the console's Integrations (`manual`, `rfc8823`, or
 * `none` to turn enrollment off) takes the next enrollment without a restart. The RFC 8823 backend is built for the CA directory and contact in force (its
 * ACME account is tied to its CA), so a changed directory or contact builds another one.
 *
 * **An enrollment in flight keeps its backend.** Every backend this process has used stays, and a call about an enrollment id goes to the backend that knows
 * the id; the listings (`listPendingEnrollments()` for the background job and for the key vault's refusal to rotate keys mid-enrollment, `listEnrollments()`,
 * `listAdminEnrollments()`) cover all of them, and a member only an earlier backend has (the RFC 8823 challenge correlation, the manual administrator's
 * upload) stays reachable. An id no backend knows gets the answer of the backend in force, which is what makes a client clear a stale id. After a restart only
 * the backend then configured is built, as before this existed.
 *
 * It is a `Proxy`, because what restapi's callers feature-detect (`typeof enrollment.checkNow === "function"`, `enrollment.health`) must be true of the
 * backends and not of this class; this class itself has only `init()` and what the Proxy needs.
 */
export class DelegatingSigningCertificateEnrollment {
    // The backend configured when the server started: it applies in a process with no host. Otherwise the three are read at each use (`liveConfig()`).
    @Config("mail:pki:signing_enrollment:backend", "manual")
    private configuredBackend: unknown = "manual";

    @Config("mail:pki:rfc8823:directory_url", null)
    private configuredDirectoryUrl: unknown = null;

    @Config("mail:pki:rfc8823:contact_email", null)
    private configuredContactEmail: unknown = null;

    @Logger
    private logger: any;

    /** Every backend built so far, by its key, in the order built. */
    private readonly backends: Map<string, SigningCertificateEnrollment> = new Map();
    private currentId?: string;
    private switching?: Promise<void>;
    /** The backend that last failed to build and when, so a call that doesn't start an enrollment doesn't try it again at once. */
    private failed?: { id: string; at: number; message: string };
    /** How long after a failed build the calls that don't start an enrollment leave that backend alone. */
    protected retryAfterMs: number = 30_000;

    constructor() {
        return new Proxy(this, {
            get: (target, property, receiver) => {
                if (typeof property === "symbol" || property in target) {
                    return Reflect.get(target, property, receiver);
                }
                return target.delegated(property);
            },
        });
    }

    /** Builds the backend in force, so `kind` and `name` are known from the start. */
    @Init
    public async init(): Promise<void> {
        await this.ensureCurrent();
    }

    /** The backend the configuration names now. */
    private desiredKey(): SigningBackendKey {
        const backend: unknown = liveConfig("mail:pki:signing_enrollment:backend", this.configuredBackend);
        if (backend === "none") {
            return { kind: "none" };
        }
        if (backend === "rfc8823") {
            const directoryUrl: string | undefined = text(liveConfig("mail:pki:rfc8823:directory_url", this.configuredDirectoryUrl));
            const contactEmail: string | undefined = text(liveConfig("mail:pki:rfc8823:contact_email", this.configuredContactEmail));
            return { kind: "rfc8823", ...(directoryUrl ? { directoryUrl } : {}), ...(contactEmail ? { contactEmail } : {}) };
        }
        // As the server has always picked it: "rfc8823" opts in, anything else is the manual flow.
        return { kind: "manual" };
    }

    /** Builds one backend. It reads the configuration as it is now, which is what `key` was made from. Overridden by the tests. */
    protected async createBackend(key: SigningBackendKey): Promise<SigningCertificateEnrollment> {
        const factory: any = (this as any)._objectFactory;
        if (!factory) {
            throw new Error("objectFactory is not set.");
        }
        switch (key.kind) {
            case "none":
                return new NullSigningCertificateEnrollment();
            case "rfc8823":
                // One per CA and contact: the factory builds an instance once per name.
                return await factory.newInstance(Rfc8823AcmeSigningCertificateEnrollment, { name: `rfc8823:${createHash("sha256").update(JSON.stringify(key)).digest("hex").slice(0, 16)}` });
            default:
                return await factory.newInstance(ManualSigningCertificateEnrollment, { name: "default" });
        }
    }

    /**
     * Makes the backend the configuration names the one in force, building it if this is the first time.
     *
     * A backend that can't be built leaves the one in force, and only `strict` (the start of an enrollment, which is what the backend is for) fails with the
     * error: every other call, the listings the background job and the key vault rely on and the calls about enrollments in flight, goes on with the backend it
     * has, logs the failure once, and does not try the build again for `retryAfterMs`. Without any backend in force (the start-up build) it always fails.
     */
    private async ensureCurrent(strict: boolean = false): Promise<void> {
        for (;;) {
            const key: SigningBackendKey = this.desiredKey();
            const id: string = JSON.stringify(key);
            if (id === this.currentId) {
                return;
            }
            if (!strict && this.currentId !== undefined && this.failed?.id === id && Date.now() - this.failed.at < this.retryAfterMs) {
                return;
            }
            if (this.switching) {
                // One build at a time; look again afterwards, since the configuration may have moved on.
                try {
                    await this.switching;
                } catch {
                    // Whoever started that build reports it.
                }
                continue;
            }
            this.switching = (async () => {
                if (!this.backends.has(id)) {
                    this.backends.set(id, await this.createBackend(key));
                    this.logger?.info(`Signing certificate enrollments now start with the ${key.kind} backend.`);
                }
                this.currentId = id;
                this.failed = undefined;
            })().finally(() => {
                this.switching = undefined;
            });
            try {
                await this.switching;
            } catch (err: any) {
                const message: string = String(err?.message ?? err);
                if (strict || this.currentId === undefined) {
                    throw err;
                }
                if (this.failed?.id !== id || this.failed.message !== message) {
                    this.logger?.warn(`The ${key.kind} signing certificate backend could not be built, so the ${this.backendKind()} one stays in force: ${message}`);
                }
                this.failed = { id, at: Date.now(), message };
            }
            return;
        }
    }

    /** The kind of the backend in force. */
    private backendKind(): string {
        return this.currentId === undefined ? "none yet" : (JSON.parse(this.currentId) as SigningBackendKey).kind;
    }

    /** The backend in force first, then the others, the latest first. */
    private ordered(): SigningCertificateEnrollment[] {
        const current: SigningCertificateEnrollment | undefined = this.currentId === undefined ? undefined : this.backends.get(this.currentId);
        const others: SigningCertificateEnrollment[] = [...this.backends.entries()].filter(([id]) => id !== this.currentId).map(([, backend]) => backend).reverse();
        return current ? [current, ...others] : others;
    }

    /** What `property` is on this object: the backend's own member, as the callers that feature-detect it see it. */
    private delegated(property: string): unknown {
        const backends: any[] = this.ordered();
        if (ACTIVE_ONLY.has(property)) {
            // The backend the configuration names now when it is built (a saved change shows at once), else the one in force.
            const value: unknown = (this.backends.get(JSON.stringify(this.desiredKey())) ?? backends[0])?.[property];
            return typeof value === "function"
                ? async (...args: unknown[]) => {
                      // Only the start of an enrollment fails for a backend that can't be built; the others report the one in force.
                      await this.ensureCurrent(property === "startEnrollment");
                      return await this.ordered()[0][property](...args);
                  }
                : value;
        }
        if (AGGREGATED.has(property)) {
            return backends.some((backend) => typeof backend[property] === "function") ? (...args: unknown[]) => this.aggregate(property, args) : undefined;
        }
        if (BY_ENROLLMENT.has(property)) {
            return backends.some((backend) => typeof backend[property] === "function") ? (id: string, ...rest: unknown[]) => this.forEnrollment(property, id, rest) : undefined;
        }
        // Anything else (the RFC 8823 backend's challenge correlation and health) is the first backend that has it.
        const owner: any = backends.find((backend) => property in backend);
        const value: unknown = owner?.[property];
        return typeof value === "function" ? value.bind(owner) : value;
    }

    /** `property` of every backend that has it, the enrollments of an id only once (two RFC 8823 backends share one store). */
    private async aggregate(property: string, args: unknown[]): Promise<unknown[]> {
        await this.ensureCurrent();
        const seen: Set<string> = new Set();
        const all: unknown[] = [];
        for (const backend of this.ordered() as any[]) {
            if (typeof backend[property] !== "function") {
                continue;
            }
            for (const entry of (await backend[property](...args)) as any[]) {
                const id: string | undefined = entry?.enrollmentId;
                if (id === undefined || !seen.has(id)) {
                    if (id !== undefined) {
                        seen.add(id);
                    }
                    all.push(entry);
                }
            }
        }
        return all;
    }

    /** Runs `property` on the backend that knows enrollment `id`, else on the one in force (whose error for an unknown id is the answer). */
    private async forEnrollment(property: string, id: string, rest: unknown[]): Promise<unknown> {
        await this.ensureCurrent();
        const backends: any[] = this.ordered();
        const capable: any[] = backends.filter((backend) => typeof backend[property] === "function");
        let known: any;
        if (backends.length > 1) {
            for (const backend of backends) {
                if (typeof backend.describeEnrollment !== "function") {
                    continue;
                }
                try {
                    await backend.describeEnrollment(id);
                } catch {
                    continue;
                }
                known = backend;
                break;
            }
        }
        if (known && typeof known[property] !== "function") {
            // The enrollment's own backend doesn't do this, and no other one may be asked, since it doesn't know the id (an RFC 8823 backend would answer a
            // manual enrollment's check with "unknown"). A manual enrollment has nothing to poll, so restapi's callers take its progress when the member is
            // missing: that is what they were given before there was a delegation.
            if (property === "checkNow" && typeof known.describeProgress === "function") {
                return await known.describeProgress(id);
            }
            throw new Error(`The backend of signing certificate enrollment '${id}' does not support ${property}().`);
        }
        const owner: any = known ?? capable[0];
        if (!owner) {
            throw new Error(`No signing certificate backend supports ${property}().`);
        }
        return await owner[property](id, ...rest);
    }
}
