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
 * Wraps a route's check of its caller (`authorizeInternalCaller()`, a private method of `BaseMailIngestRoute`, by default; `authorize()`, an asynchronous
 * private method of `BaseDnsDesiredStateRoute`, for the DNS controller's API), which each of its routes calls first, so a proxied request is refused and a wrong
 * secret or token is counted and, past the limit, answered 429. A correct one always passes. Applied to the route's prototype, since the base method is private to
 * TypeScript.
 *
 * @param routeClass The route subclass, whose instances have `allowForwarded` and `trustedProxies` set from configuration.
 * @param guard The guard to use; one per process and API, so one API's wrong secrets don't count against another's callers.
 * @param method The name of the check. Throws when the route has none, so a base route that renames it can't be left unguarded without anyone noticing.
 */
export function guardInternalCaller(routeClass: { prototype: any }, guard: InternalCallerGuard = new InternalCallerGuard(), method: string = "authorizeInternalCaller"): void {
    const authorize: ((req: any) => unknown) | undefined = routeClass.prototype[method];
    if (typeof authorize !== "function") {
        throw new Error(`The route has no ${method}() to guard, so its callers would not be checked for a proxy or counted.`);
    }
    // An asynchronous check refuses with a rejection, as its callers (which await it) expect, a synchronous one by throwing.
    const isAsync: boolean = authorize.constructor.name === "AsyncFunction";
    routeClass.prototype[method] = function (this: any, req: any): unknown {
        try {
            guard.check(req, this.allowForwarded === true);
        } catch (err) {
            if (isAsync) {
                return Promise.reject(err);
            }
            throw err;
        }
        const refuse = (err: unknown): never => {
            if (guard.noteFailure(req, this.trustedProxies)) {
                throw new ApiError(ApiErrors.AUTH_PERMISSION_FAILURE, 429, "Too many failed attempts. Try again later.");
            }
            throw err;
        };
        let result: unknown;
        try {
            result = authorize.call(this, req);
        } catch (err) {
            return refuse(err);
        }
        return result instanceof Promise ? result.catch(refuse) : result;
    };
}
