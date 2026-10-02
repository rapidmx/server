///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ApiError } from "@rapidrest/core";
import { ApiErrors } from "@rapidrest/service-core";
import { clientAddress, rateLimitAddress, trustedProxyList } from "./TieredRateLimiter.js";

/** Headers a proxy or load balancer adds to a request it forwards. The in-cluster MTA bridge never sends them. */
const PROXY_HEADERS: readonly string[] = ["x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip", "forwarded"];

/** Options for `InternalCallerGuard`. */
export interface InternalCallerGuardOptions {
    /** Accept a request that carries proxy headers. Default `false`: /internal is only for callers that reach this server directly. */
    allowForwarded?: boolean;
    /** Wrong secrets, per client address, within `failureWindowMs`, after which a further wrong secret is answered 429. Default 10. */
    failureLimit?: number;
    /** Default 15 minutes. */
    failureWindowMs?: number;
    /** Most addresses remembered at once. Default 5000. */
    maxEntries?: number;
}

/**
 * Protection for the MTA hand-off API (`/internal/mta`), which shares the public API's port and is authenticated only by a
 * bearer secret: it refuses a request that has been through a proxy (so one that came in through the public Gateway or an
 * ingress is never served, even if a routing rule is lost), and answers 429 to a wrong secret from an address that has
 * presented too many. A correct secret is never refused: the bridges read every error as a reason to reject or bounce mail,
 * so a stranger's guesses must not be able to turn the real caller away.
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

    /**
     * Throws 403 for a proxied request, which is not served. Not 404: both bridges read that as "no such domain or recipient"
     * and reject or bounce the mail for good, where any other status is a failure the MTA retries.
     */
    public check(req: any, allowForwarded: boolean = this.options.allowForwarded ?? false): void {
        if (!allowForwarded && PROXY_HEADERS.some((name) => req?.headers?.[name] !== undefined)) {
            throw new ApiError(ApiErrors.AUTH_PERMISSION_FAILURE, 403, "Forbidden.");
        }
    }

    /**
     * Counts one wrong secret against the caller's address, and returns whether the address is past the limit.
     *
     * @param trustedProxies `trusted_proxies`: behind one of these the caller is the nearest address in `X-Forwarded-For` that isn't.
     */
    public noteFailure(req: any, trustedProxies: string[] | string | undefined = []): boolean {
        const address: string = this.addressOf(req, trustedProxies);
        const now: number = Date.now();
        const failures = this.failures.get(address);
        if (failures && now - failures.since <= this.windowMs) {
            failures.count += 1;
            return failures.count > this.limit;
        }
        this.failures.set(address, { count: 1, since: now });
        // Bounded: a flood of distinct addresses must not grow this without limit. A Map iterates in insertion order.
        while (this.failures.size > (this.options.maxEntries ?? 5000)) {
            this.failures.delete(this.failures.keys().next().value!);
        }
        return 1 > this.limit;
    }

    /** The caller's address the way the rate limiter resolves it, so behind a load balancer it isn't the balancer's. */
    private addressOf(req: any, trustedProxies: string[] | string | undefined): string {
        const resolved: string | undefined = clientAddress(req, trustedProxyList(trustedProxies));
        return resolved ? rateLimitAddress(resolved) : "unknown";
    }
}

/**
 * Wraps a route's `authorizeInternalCaller()` (a private method of `BaseMailIngestRoute`, called first by each of its
 * routes) so a proxied request is refused and a wrong secret is counted and, past the limit, answered 429. A correct secret
 * always passes. Applied to the route's prototype, since the base method is private to TypeScript.
 *
 * @param routeClass The `MailIngestRoute` subclass, whose instances have `allowForwarded` and `trustedProxies` set from configuration.
 * @param guard The guard to use; one per process.
 */
export function guardInternalCaller(routeClass: { prototype: any }, guard: InternalCallerGuard = new InternalCallerGuard()): void {
    const authorize: (req: any) => void = routeClass.prototype.authorizeInternalCaller;
    routeClass.prototype.authorizeInternalCaller = function (this: any, req: any): void {
        guard.check(req, this.allowForwarded === true);
        try {
            authorize.call(this, req);
        } catch (err) {
            if (guard.noteFailure(req, this.trustedProxies)) {
                throw new ApiError(ApiErrors.AUTH_PERMISSION_FAILURE, 429, "Too many failed attempts. Try again later.");
            }
            throw err;
        }
    };
}
