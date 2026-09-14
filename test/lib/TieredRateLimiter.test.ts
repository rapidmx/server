///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import nconf from "nconf";
import { Logger } from "@rapidrest/core";
import { ObjectFactory, RateLimiter } from "@rapidrest/service-core";
import { clientAddress, rateLimitAddress, TieredRateLimiter, trustedProxyList } from "../../src/lib/TieredRateLimiter.js";
import mongoConfig from "../../src/config.mongo.js";
import sqlConfig from "../../src/config.sql.js";

describe("TieredRateLimiter", () => {
    let objectFactory: ObjectFactory;

    afterEach(async () => {
        await objectFactory?.destroy();
    });

    async function limiter(rateLimit: any, trustedProxies: string[] = []): Promise<RateLimiter> {
        const config = new nconf.Provider();
        config.use("memory");
        config.defaults({ rateLimit, trusted_proxies: trustedProxies });
        objectFactory = new ObjectFactory(config, new Logger());
        objectFactory.register(TieredRateLimiter, "RateLimiter");
        return objectFactory.newInstance(RateLimiter, { name: "default" });
    }

    const anonymous = (ip = "10.0.0.1") => ({ headers: {}, socket: { remoteAddress: ip } }) as any;
    const signedIn = (uid: string, ip = "10.0.0.1") => ({ ...anonymous(ip), user: { uid } });

    async function attempts(rl: RateLimiter, count: number, id: string, req: any): Promise<number> {
        for (let i = 0; i < count; i++) {
            try {
                await rl.checkAndIncrement(id, { perUser: true } as any, req);
            } catch (err: any) {
                expect(err.status).toBe(429);
                return i;
            }
        }
        return count;
    }

    const limits = {
        enabled: true,
        maxAttempts: 3,
        windowSeconds: 60,
        ip: { enabled: true, maxAttempts: 5, windowSeconds: 300 },
        authenticated: { maxAttempts: 50, windowSeconds: 300, ip: { maxAttempts: 80 } },
    };

    it("replaces RateLimiter when registered under its name", async () => {
        expect(await limiter(limits)).toBeInstanceOf(TieredRateLimiter);
    });

    it("keeps anonymous requests to the conservative limits, per identifier and per IP", async () => {
        const rl = await limiter(limits);
        expect(await attempts(rl, 10, "POST|/booking/types/a/book", anonymous())).toBe(3);
        // A different endpoint from the same IP runs into the per-IP limit (5 in total).
        expect(await attempts(rl, 10, "POST|/booking/types/b/book", anonymous())).toBe(2);
        // Another IP is unaffected by that IP's counter.
        expect(await attempts(rl, 1, "GET|/other", anonymous("10.0.0.2"))).toBe(1);
    });

    it("keys an anonymous endpoint counter by source IP, so one caller can't use up an endpoint for everyone", async () => {
        const rl = await limiter({ ...limits, ip: { enabled: true, maxAttempts: 50, windowSeconds: 300 } });
        expect(await attempts(rl, 10, "GET|/.well-known/key/bob", anonymous("10.0.0.1"))).toBe(3);
        expect(await attempts(rl, 10, "GET|/.well-known/key/bob", anonymous("10.0.0.2"))).toBe(3);
    });

    it("keeps one shared counter for a route with an explicit id", async () => {
        const rl = await limiter({ ...limits, ip: { enabled: true, maxAttempts: 50, windowSeconds: 300 } });
        const count = async (ip: string) => {
            for (let i = 0; i < 10; i++) {
                try {
                    await rl.checkAndIncrement("login", { id: "login" } as any, anonymous(ip));
                } catch {
                    return i;
                }
            }
            return 10;
        };
        expect(await count("10.0.0.1")).toBe(3);
        expect(await count("10.0.0.2")).toBe(0);
    });

    it("takes the client address from X-Forwarded-For only behind a trusted proxy, including CIDR ranges", async () => {
        const trusted = trustedProxyList(["10.0.0.0/8", "fc00::/7", "192.168.1.1", "not-an-ip", "10.0.0.0/99"]);
        const req = (remoteAddress: string, headers: Record<string, string> = {}) => ({ socket: { remoteAddress }, headers });
        // The nearest untrusted address wins, so a client-supplied entry to the left of it is ignored.
        expect(clientAddress(req("10.1.2.3", { "x-forwarded-for": "6.6.6.6, 203.0.113.9, 10.9.9.9" }), trusted)).toBe("203.0.113.9");
        expect(clientAddress(req("::ffff:10.1.2.3", { "x-forwarded-for": "203.0.113.9" }), trusted)).toBe("203.0.113.9");
        expect(clientAddress(req("fd00::1", { "x-real-ip": "2001:db8::5" }), trusted)).toBe("2001:db8::5");
        expect(clientAddress(req("192.168.1.1", { "x-forwarded-for": "10.0.0.5" }), trusted)).toBe("10.0.0.5");
        expect(clientAddress(req("192.168.1.2", { "x-forwarded-for": "203.0.113.9" }), trusted)).toBe("192.168.1.2");
        expect(clientAddress(req("10.1.2.3", { "x-forwarded-for": "garbage" }), trusted)).toBe("10.1.2.3");

        const rl = await limiter(limits, ["10.0.0.0/8"]);
        const behindGateway = (client: string) => ({ headers: { "x-forwarded-for": client }, socket: { remoteAddress: "10.244.0.7" } }) as any;
        expect(await attempts(rl, 10, "GET|/.well-known/key/bob", behindGateway("203.0.113.1"))).toBe(3);
        expect(await attempts(rl, 10, "GET|/.well-known/key/bob", behindGateway("203.0.113.2"))).toBe(3);
    });

    it("reduces IPv6 addresses to their /64 (or configured) network for counting, leaving IPv4 alone", () => {
        expect(rateLimitAddress("203.0.113.9")).toBe("203.0.113.9");
        expect(rateLimitAddress("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).toBe("2001:db8:1:2:0:0:0:0/64");
        expect(rateLimitAddress("2001:db8:1:2::1")).toBe("2001:db8:1:2:0:0:0:0/64");
        expect(rateLimitAddress("2001:db8::")).toBe("2001:db8:0:0:0:0:0:0/64");
        expect(rateLimitAddress("::1")).toBe("0:0:0:0:0:0:0:0/64");
        expect(rateLimitAddress("64:ff9b::192.0.2.33", 96)).toBe("64:ff9b:0:0:0:0:0:0/96");
        expect(rateLimitAddress("2001:db8:1:2ff::1", 56)).toBe("2001:db8:1:200:0:0:0:0/56");
        expect(rateLimitAddress("2001:db8:1:2::1", 128)).toBe("2001:db8:1:2::1");
    });

    it("counts one IPv6 /64 as a single client", async () => {
        const rl = await limiter({ ...limits, ipv6_prefix_length: 64 });
        const rotating = (i: number) => anonymous(`2001:db8:1:2::${i + 1}`);
        let allowed = 0;
        for (let i = 0; i < 10; i++) {
            try {
                await rl.checkAndIncrement("GET|/.well-known/key/bob", { perUser: true } as any, rotating(i));
                allowed++;
            } catch (err: any) {
                expect(err.status).toBe(429);
            }
        }
        expect(allowed).toBe(3);
        // Another /64 has its own budget.
        expect(await attempts(rl, 10, "GET|/.well-known/key/bob", anonymous("2001:db8:1:3::1"))).toBe(3);
    });

    it("gives signed-in requests the authenticated limits, with a per-IP counter apart from the anonymous one", async () => {
        const rl = await limiter(limits);
        expect(await attempts(rl, 60, "alice|GET|/mailbox/1/keys/lookup", signedIn("alice"))).toBe(50);
        expect(await attempts(rl, 60, "bob|GET|/mailbox/2/keys/lookup", signedIn("bob"))).toBe(30);
        // Signed-in traffic didn't use up the anonymous budget of the same IP.
        expect(await attempts(rl, 10, "GET|/.well-known/key", anonymous())).toBe(3);
    });

    it("falls back to the top-level limits when no authenticated tier is configured, and does nothing when disabled", async () => {
        const { authenticated: _unused, ...untiered } = limits;
        expect(await attempts(await limiter(untiered), 10, "alice|GET|/x", signedIn("alice"))).toBe(3);
        await objectFactory.destroy();
        expect(await attempts(await limiter({ ...limits, enabled: false }), 100, "GET|/x", anonymous())).toBe(100);
    });

    it("ships conservative anonymous limits and very high signed-in limits", () => {
        for (const config of [mongoConfig, sqlConfig]) {
            const rateLimit = config.get("rateLimit");
            expect(rateLimit.maxAttempts).toBeLessThanOrEqual(100);
            expect(rateLimit.ip.maxAttempts).toBeLessThanOrEqual(100);
            expect(rateLimit.authenticated.maxAttempts).toBeGreaterThanOrEqual(10_000);
            expect(rateLimit.authenticated.ip.maxAttempts).toBeGreaterThanOrEqual(20_000);
            expect(config.get("trusted_proxies")).toEqual([]);
            expect(rateLimit.ipv6_prefix_length).toBe(64);
        }
    });
});
