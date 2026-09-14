///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import net from "net";
import { RateLimiter, type RateLimitConfig, type RateLimiterConfig } from "@rapidrest/service-core";

/** `rateLimit` config: the top-level limits apply to anonymous callers, `authenticated` to signed-in ones. */
export interface TieredRateLimiterConfig extends RateLimiterConfig {
    authenticated?: RateLimitConfig;
    /** IPv6 clients are counted per network of this prefix length (default 64); 128 counts each address. */
    ipv6_prefix_length?: number;
}

/** The 16 bytes of an IPv6 address (`net.isIP(address) === 6`), or `undefined` if it can't be parsed. */
function ipv6Bytes(address: string): number[] | undefined {
    let text: string = address;
    const tail: number[] = [];
    const v4: RegExpMatchArray | null = text.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
    if (v4) {
        const octets: number[] = v4[2].split(".").map(Number);
        tail.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
        text = v4[1].endsWith("::") ? v4[1] : v4[1].slice(0, -1);
    }
    const [head, rest] = text.split("::");
    const parse = (part: string | undefined): number[] => (part ? part.split(":").map((group) => parseInt(group, 16)) : []);
    const left: number[] = parse(head);
    const right: number[] = [...parse(rest), ...tail];
    const groups: number[] = rest === undefined ? [...left, ...tail] : [...left, ...new Array(8 - left.length - right.length).fill(0), ...right];
    if (groups.length !== 8 || groups.some((group) => !Number.isInteger(group) || group < 0 || group > 0xffff)) {
        return undefined;
    }
    return groups.flatMap((group) => [group >> 8, group & 0xff]);
}

/**
 * The address a rate-limit counter is kept for: IPv4 addresses as they are, IPv6 addresses reduced to their
 * `/prefixLength` network (e.g. `2001:db8:0:1::/64`), since one host is typically assigned a whole /64 and could
 * otherwise use a different address for every request.
 */
export function rateLimitAddress(address: string, prefixLength: number = 64): string {
    if (net.isIP(address) !== 6) {
        return address;
    }
    const prefix: number = Number.isInteger(prefixLength) ? Math.min(Math.max(prefixLength, 0), 128) : 64;
    const bytes: number[] | undefined = ipv6Bytes(address);
    if (!bytes || prefix === 128) {
        return address;
    }
    const masked: number[] = bytes.map((byte, i) => {
        const bits: number = Math.min(Math.max(prefix - i * 8, 0), 8);
        return byte & ((0xff << (8 - bits)) & 0xff);
    });
    const groups: string[] = [];
    for (let i = 0; i < 16; i += 2) {
        groups.push(((masked[i] << 8) | masked[i + 1]).toString(16));
    }
    return `${groups.join(":")}/${prefix}`;
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
        const { authenticated, ipv6_prefix_length: ipv6PrefixLength, ...anonymous }: TieredRateLimiterConfig = this.config as TieredRateLimiterConfig;
        if (!req || this.config.enabled === false) {
            return super.checkAndIncrement(identifier, config, req);
        }
        const signedIn: boolean = !!authenticated && !!req.user?.uid;
        const limits: RateLimitConfig = signedIn ? { ...anonymous, ...authenticated, ...config } : { ...anonymous, ...config };
        const ip = signedIn ? { ...anonymous.ip, ...authenticated!.ip, ...config?.ip } : { ...anonymous.ip, ...config?.ip };
        const resolved: string | undefined = clientAddress(req, this.trusted());
        const address: string | undefined = resolved && rateLimitAddress(resolved, ipv6PrefixLength ?? 64);
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
