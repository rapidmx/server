///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ApiError } from "@rapidrest/core";
import { ApiErrors } from "@rapidrest/service-core";

/** Headers a proxy or load balancer adds to a request it forwards. The in-cluster MTA bridge never sends them. */
const PROXY_HEADERS: readonly string[] = ["x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip", "forwarded"];

/** Options for `InternalCallerGuard`. */
export interface InternalCallerGuardOptions {
    /** Accept a request that carries proxy headers. Default `false`: /internal is only for callers that reach this server directly. */
    allowForwarded?: boolean;
    /** Failed secret checks, per client address, within `failureWindowMs`, before every request from it gets a 429. Default 10. */
    failureLimit?: number;
    /** Default 15 minutes. */
    failureWindowMs?: number;
    /** Most addresses remembered at once. Default 5000. */
    maxEntries?: number;
}

/**
 * Protection for the MTA hand-off API (`/internal/mta`), which shares the public API's port and is authenticated only by a
 * bearer secret: it refuses a request that has been through a proxy (so one that came in through the public Gateway or an
 * ingress is never served, even if a routing rule is lost), and answers 429 to an address after too many wrong secrets.
 * The count is kept per process, like `BasicAuthJWTStrategy`'s.
 */
export class InternalCallerGuard {
    private readonly failures: Map<string, { count: number; since: number }> = new Map();

    public constructor(private readonly options: InternalCallerGuardOptions = {}) {}

    private get limit(): number {
        return this.options.failureLimit ?? 10;
    }

    private get windowMs(): number {
        return this.options.failureWindowMs ?? 900_000;
    }

    /** Throws 404 for a proxied request, 429 for a throttled address. Call before the secret is checked. */
    public check(req: any, allowForwarded: boolean = this.options.allowForwarded ?? false): void {
        if (!allowForwarded && PROXY_HEADERS.some((name) => req?.headers?.[name] !== undefined)) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, "Not found.");
        }
        const failures = this.failures.get(this.addressOf(req));
        if (failures) {
            if (Date.now() - failures.since > this.windowMs) {
                this.failures.delete(this.addressOf(req));
            } else if (failures.count >= this.limit) {
                throw new ApiError(ApiErrors.AUTH_PERMISSION_FAILURE, 429, "Too many failed attempts. Try again later.");
            }
        }
    }

    /** Counts one wrong secret against the caller's address. */
    public noteFailure(req: any): void {
        const address: string = this.addressOf(req);
        const now: number = Date.now();
        const failures = this.failures.get(address);
        if (failures && now - failures.since <= this.windowMs) {
            failures.count += 1;
            return;
        }
        this.failures.set(address, { count: 1, since: now });
        // Bounded: a flood of distinct addresses must not grow this without limit. A Map iterates in insertion order.
        while (this.failures.size > (this.options.maxEntries ?? 5000)) {
            this.failures.delete(this.failures.keys().next().value!);
        }
    }

    /** The connection's own address: this is only ever used for callers that are not behind a proxy. */
    private addressOf(req: any): string {
        return String(req?.socket?.remoteAddress ?? "unknown");
    }
}

/**
 * Wraps a route's `authorizeInternalCaller()` (a private method of `BaseMailIngestRoute`, called first by each of its
 * routes) so a proxied request is refused, a throttled address is turned away, and a wrong secret is counted. Applied to the
 * route's prototype, since the base method is private to TypeScript.
 *
 * @param routeClass The `MailIngestRoute` subclass, whose instances have `allowForwarded` set from configuration.
 * @param guard The guard to use; one per process.
 */
export function guardInternalCaller(routeClass: { prototype: any }, guard: InternalCallerGuard = new InternalCallerGuard()): void {
    const authorize: (req: any) => void = routeClass.prototype.authorizeInternalCaller;
    routeClass.prototype.authorizeInternalCaller = function (this: any, req: any): void {
        guard.check(req, this.allowForwarded === true);
        try {
            authorize.call(this, req);
        } catch (err) {
            guard.noteFailure(req);
            throw err;
        }
    };
}
