///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { NetUtils, RateLimiter, type RateLimitConfig, type RateLimiterConfig } from "@rapidrest/service-core";

/** `rateLimit` config: the top-level limits apply to anonymous callers, `authenticated` to signed-in ones. */
export interface TieredRateLimiterConfig extends RateLimiterConfig {
    authenticated?: RateLimitConfig;
}

/**
 * `@rapidrest/service-core`'s `RateLimiter`, with separate limits for signed-in callers. Registered in place of
 * `RateLimiter` (`objectFactory.register(TieredRateLimiter, "RateLimiter")`), so every `@RateLimit()` route uses it.
 *
 * Anonymous requests get the conservative top-level `rateLimit` limits, per identifier and per source IP: they reach
 * public endpoints that send mail or can be enumerated (booking, key discovery). A request authenticated as a user
 * (`req.user.uid`, set before the rate limiter runs) gets `rateLimit.authenticated` instead - very high limits that only
 * stop runaway automation. Its per-IP counter is kept apart from the anonymous one, so signed-in traffic from a shared
 * office IP never uses up the anonymous budget of that IP, or the other way round.
 */
export class TieredRateLimiter extends RateLimiter {
    public async checkAndIncrement(identifier: string, config?: RateLimitConfig, req?: any): Promise<void> {
        const { authenticated, ...anonymous }: TieredRateLimiterConfig = this.config as TieredRateLimiterConfig;
        if (!authenticated || !req?.user?.uid || this.config.enabled === false) {
            return super.checkAndIncrement(identifier, config, req);
        }
        const limits: RateLimitConfig = { ...anonymous, ...authenticated, ...config };
        const ip = { ...anonymous.ip, ...authenticated.ip, ...config?.ip };
        // Without a request the base class checks only the identifier counter.
        await super.checkAndIncrement(identifier, { maxAttempts: limits.maxAttempts, windowSeconds: limits.windowSeconds });
        const address: string | undefined = ip.enabled === false ? undefined : NetUtils.getIPAddress(req, this.trustedProxies);
        if (address) {
            await super.checkAndIncrement(`authenticated-ip:${address}`, { maxAttempts: ip.maxAttempts ?? 100, windowSeconds: ip.windowSeconds ?? 300 });
        }
    }
}
