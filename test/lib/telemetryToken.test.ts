///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import nconf from "nconf";
import { EventUtils, JWTUtils } from "@rapidrest/core";
import { createTelemetryToken, startTelemetryToken, telemetryTokenRenewIntervalMs, telemetryTokenTtlSeconds } from "../../src/lib/telemetryToken.js";
import mongoConfig from "../../src/config.mongo.js";
import sqlConfig from "../../src/config.sql.js";

/** A token's claims, unverified. */
const claimsOf = (token: string): any => JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf-8"));
/** The token's profile claim, which JWTUtils stores as a JSON string. */
const profileOf = (payload: any): any => (typeof payload.profile === "string" ? JSON.parse(payload.profile) : payload.profile);

function testConfig(overrides: Record<string, any> = {}): nconf.Provider {
    const config = new nconf.Provider();
    config.use("memory");
    config.defaults({
        service_name: "server",
        trusted_roles: ["admin"],
        auth: { secret: "test-secret", options: { audience: "aud", issuer: "iss", expiresIn: "1 hour" } },
        telemetry_services: { token_roles: ["telemetry"], token_ttl_seconds: 600 },
        ...overrides,
    });
    return config;
}

describe("telemetry token", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("expires after token_ttl_seconds and carries only the telemetry roles, never trusted_roles", async () => {
        const config = testConfig();
        const token: string = await createTelemetryToken(config);
        // Verifies with the shared secret.
        await JWTUtils.decodeToken({ secret: "test-secret", options: {} }, token);
        const payload: any = claimsOf(token);
        expect(payload.exp - payload.iat).toBe(600);
        expect(profileOf(payload).roles).toEqual(["telemetry"]);
        expect(JSON.stringify(payload)).not.toContain("admin");
        // The shared auth config isn't modified.
        expect(config.get("auth:options:expiresIn")).toBe("1 hour");
    });

    it("falls back to a one hour lifetime and the telemetry role for missing or invalid settings", async () => {
        const config = testConfig({ telemetry_services: { token_ttl_seconds: 5 } });
        expect(telemetryTokenTtlSeconds(config)).toBe(3_600);
        const payload: any = claimsOf(await createTelemetryToken(config));
        expect(profileOf(payload).roles).toEqual(["telemetry"]);
    });

    it("caps the renewal interval at the largest timer delay, so a very long lifetime doesn't renew every millisecond", async () => {
        expect(telemetryTokenRenewIntervalMs(testConfig())).toBe(300_000);
        const config = testConfig({ telemetry_services: { token_ttl_seconds: 10 * 365 * 24 * 3_600 } });
        expect(telemetryTokenRenewIntervalMs(config)).toBe(2 ** 31 - 1);

        vi.useFakeTimers();
        const telemetry = await startTelemetryToken(config, { warn: vi.fn() });
        const first: string = (EventUtils as any).token;
        vi.setSystemTime(Date.now() + 2_000);
        await vi.advanceTimersByTimeAsync(60_000);
        expect((EventUtils as any).token).toBe(first);
        telemetry.stop();
    });

    it("renews the token EventUtils sends with at half its lifetime", async () => {
        vi.useFakeTimers();
        const config = testConfig();
        const telemetry = await startTelemetryToken(config, { warn: vi.fn() });
        const first: string = (EventUtils as any).token;
        vi.setSystemTime(Date.now() + 2_000);
        await vi.advanceTimersByTimeAsync(300_000);
        const renewed: string = (EventUtils as any).token;
        expect(renewed).not.toBe(first);
        telemetry.stop();
        await vi.advanceTimersByTimeAsync(300_000);
        expect((EventUtils as any).token).toBe(renewed);
    });

    it("ships a short-lived telemetry token without trusted roles", () => {
        for (const config of [mongoConfig, sqlConfig]) {
            expect(config.get("telemetry_services:token_roles")).toEqual(["telemetry"]);
            expect(config.get("telemetry_services:token_ttl_seconds")).toBeLessThanOrEqual(3_600);
        }
    });
});
