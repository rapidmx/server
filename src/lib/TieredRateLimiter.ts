///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import net from "net";
import { RateLimiter, type RateLimitConfig, type RateLimiterConfig } from "@rapidrest/service-core";

/** `rateLimit` config: the top-level limits apply to anonymous callers, `authenticated` to signed-in ones. */
export interface TieredRateLimiterConfig extends RateLimiterConfig {
    authenticated?: RateLimitConfig;
}

/** Strips the IPv4-mapped IPv6 prefix (`::ffff:10.0.0.1` -> `10.0.0.1`) and an IPv6 zone. */
function normalizeAddress(address: string): string {
    return address.trim().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, "").replace(/%.*$/, "");
}

/** A `BlockList` of `trusted_proxies`: exact addresses and CIDR ranges (`10.0.0.0/8`, `fc00::/7`). */
export function trustedProxyList(entries: string[] | string | undefined): net.BlockList {
    const list: net.BlockList = new net.BlockList();
    for (const entry of Array.isArray(entries) ? entries : String(entries ?? "").split(",")) {
        const [address, prefix] = String(entry).trim().split("/");
        const family: number = net.isIP(address);
        if (!family) {
            continue;
        }
        const type: "ipv4" | "ipv6" = family === 4 ? "ipv4" : "ipv6";
        try {
            if (prefix === undefined) {
                list.addAddress(address, type);
            } else {
                list.addSubnet(address, Number(prefix), type);
            }
        } catch {
            // An invalid prefix length: the entry trusts nothing.
        }
    }
    return list;
}

function isTrusted(list: net.BlockList, address: string): boolean {
    const family: number = net.isIP(address);
    return family !== 0 && list.check(address, family === 4 ? "ipv4" : "ipv6");
}

/**
 * The address a request came from. A connection from a trusted proxy (`trusted_proxies`, exact addresses or CIDR
 * ranges) is attributed to the nearest untrusted address in its `X-Forwarded-For` (read right to left, as each proxy
 * appends the address it saw), or its `X-Real-IP` - so a client can't pick its own address by sending the header itself.
 */
export function clientAddress(req: any, trusted: net.BlockList): string | undefined {
    const remote: string | undefined = req?.socket?.remoteAddress ? normalizeAddress(req.socket.remoteAddress) : undefined;
    if (!remote || !isTrusted(trusted, remote)) {
        return remote;
    }
    const header = (name: string): string | undefined => {
        const value: unknown = req.headers?.[name];
        return Array.isArray(value) ? value.join(",") : typeof value === "string" ? value : undefined;
    };
    const forwarded: string[] = (header("x-forwarded-for") ?? "")
        .split(",")
        .map(normalizeAddress)
        .filter((address) => net.isIP(address) !== 0);
    for (let i = forwarded.length - 1; i >= 0; i--) {
        if (!isTrusted(trusted, forwarded[i]) || i === 0) {
            return forwarded[i];
        }
    }
    const realIp: string | undefined = header("x-real-ip") && normalizeAddress(header("x-real-ip")!);
    return realIp && net.isIP(realIp) ? realIp : remote;
}

/**
 * `@rapidrest/service-core`'s `RateLimiter`, with separate limits for signed-in callers. Registered in place of
 * `RateLimiter` (`objectFactory.register(TieredRateLimiter, "RateLimiter")`), so every `@RateLimit()` route uses it.
 *
 * Anonymous requests get the conservative top-level `rateLimit` limits, per source IP and endpoint and per source IP
 * overall: they reach public endpoints that send mail or can be enumerated (booking, key discovery). The endpoint
 * counter includes the source IP, so one caller can't use up an endpoint for everyone else (say, a recipient's key
 * discovery, which would make senders fall back to unencrypted mail); a route with an explicit `@RateLimit({ id })`
 * keeps its one shared counter. A request authenticated as a user (`req.user.uid`, set before the rate limiter runs)
 * gets `rateLimit.authenticated` instead - very high limits that only stop runaway automation. Its per-IP counter is
 * kept apart from the anonymous one, so signed-in traffic from a shared office IP never uses up the anonymous budget of
 * that IP, or the other way round.
 *
 * Source addresses honor `trusted_proxies` with CIDR ranges too (see `clientAddress()`), unlike service-core's own
 * exact-match lookup.
 */
export class TieredRateLimiter extends RateLimiter {
    private trustedList?: { entries: string[]; list: net.BlockList };

    private trusted(): net.BlockList {
        if (this.trustedList?.entries !== this.trustedProxies) {
            this.trustedList = { entries: this.trustedProxies, list: trustedProxyList(this.trustedProxies) };
        }
        return this.trustedList.list;
    }

    public async checkAndIncrement(identifier: string, config?: RateLimitConfig, req?: any): Promise<void> {
        const { authenticated, ...anonymous }: TieredRateLimiterConfig = this.config as TieredRateLimiterConfig;
        if (!req || this.config.enabled === false) {
            return super.checkAndIncrement(identifier, config, req);
        }
        const signedIn: boolean = !!authenticated && !!req.user?.uid;
        const limits: RateLimitConfig = signedIn ? { ...anonymous, ...authenticated, ...config } : { ...anonymous, ...config };
        const ip = signedIn ? { ...anonymous.ip, ...authenticated!.ip, ...config?.ip } : { ...anonymous.ip, ...config?.ip };
        const address: string | undefined = clientAddress(req, this.trusted());
        const explicitId: boolean = !!(config as any)?.id;
        const key: string = !req.user?.uid && !explicitId && address ? `anonymous:${address}|${identifier}` : identifier;
        // Without a request the base class checks only the identifier counter.
        await super.checkAndIncrement(key, { maxAttempts: limits.maxAttempts, windowSeconds: limits.windowSeconds });
        if (address && ip.enabled !== false) {
            await super.checkAndIncrement(signedIn ? `authenticated-ip:${address}` : `ip:${address}`, {
                maxAttempts: ip.maxAttempts ?? 100,
                windowSeconds: ip.windowSeconds ?? 300,
            });
        }
    }
}
