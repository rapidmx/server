///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import nconf from "nconf";
import { Logger } from "@rapidrest/core";
import { ObjectFactory, RateLimiter } from "@rapidrest/service-core";
import { TieredRateLimiter } from "../../src/lib/TieredRateLimiter.js";
import mongoConfig from "../../src/config.mongo.js";
import sqlConfig from "../../src/config.sql.js";

describe("TieredRateLimiter", () => {
    let objectFactory: ObjectFactory;

    afterEach(async () => {
        await objectFactory?.destroy();
    });

    async function limiter(rateLimit: any): Promise<RateLimiter> {
        const config = new nconf.Provider();
        config.use("memory");
        config.defaults({ rateLimit, trusted_proxies: [] });
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
        }
    });
});
