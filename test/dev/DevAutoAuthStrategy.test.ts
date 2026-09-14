///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
import config from "../../src/config.mongo.js";
import { ObjectFactory } from "@rapidrest/service-core";
import { JWTUtils, Logger } from "@rapidrest/core";
import { DEV_USER_UID, DevAutoAuthStrategy } from "../../src/dev/DevAutoAuthStrategy.js";

function fakeReq(cookies: Record<string, string> = {}): any {
    return { cookies, path: "/test" };
}

function fakeRes(): { res: any; setCookieCalls: string[] } {
    const setCookieCalls: string[] = [];
    return {
        res: {
            appendHeader: (key: string, value: string) => {
                if (key === "Set-Cookie") {
                    setCookieCalls.push(value);
                }
            },
        },
        setCookieCalls,
    };
}

describe("DevAutoAuthStrategy Tests", () => {
    const objectFactory: ObjectFactory = new ObjectFactory(config, Logger());
    let strategy: DevAutoAuthStrategy;

    beforeAll(async () => {
        strategy = await objectFactory.newInstance<DevAutoAuthStrategy>(DevAutoAuthStrategy);
    });

    it("has the name 'jwt' so it can replace the real JWTStrategy in AuthMiddleware.", () => {
        expect(strategy.name).toBe("jwt");
    });

    describe("authenticate()", () => {
        it("mints a fresh token and sets it as the jwt cookie when no cookie is present.", async () => {
            const { res, setCookieCalls } = fakeRes();
            const result = await strategy.authenticate(fakeReq(), res);

            expect(result?.user?.uid).toBe(DEV_USER_UID);
            // restapi only grants mailbox access to UUID-shaped uids.
            expect(DEV_USER_UID).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
            expect(result?.user?.roles).toEqual(["admin"]);
            expect(setCookieCalls).toHaveLength(1);
            expect(setCookieCalls[0]).toMatch(/^jwt=.+; Path=\/; SameSite=Lax$/);
        });

        it("honors an already-valid jwt cookie without minting or setting a new one.", async () => {
            const existingToken = JWTUtils.createTokenSync(config.get("auth"), {
                uid: "real-user",
                roles: ["editor"],
                scopes: [],
            });
            const { res, setCookieCalls } = fakeRes();

            const result = await strategy.authenticate(fakeReq({ jwt: existingToken }), res);

            expect(result?.user?.uid).toBe("real-user");
            expect(result?.user?.roles).toEqual(["editor"]);
            expect(setCookieCalls).toHaveLength(0);
        });

        it("re-mints a fresh token when an existing cookie decodes to this strategy's own dev uid but is missing a valid 'elevated' timestamp (a stale pre-elevation-fix token).", async () => {
            const staleDevToken = JWTUtils.createTokenSync(config.get("auth"), {
                uid: DEV_USER_UID,
                roles: ["admin"],
                scopes: [],
                // No `elevated` at all — the exact shape `buildDevUser()` produced before it started
                // setting that field.
            });
            const { res, setCookieCalls } = fakeRes();

            const result = await strategy.authenticate(fakeReq({ jwt: staleDevToken }), res);

            expect(result?.user?.uid).toBe(DEV_USER_UID);
            expect(result?.user?.elevated).toBeGreaterThan(0);
            expect(setCookieCalls).toHaveLength(1);
        });

        it("re-mints a fresh token when an existing cookie decodes to this strategy's own dev uid with a non-positive 'elevated' value.", async () => {
            const staleDevToken = JWTUtils.createTokenSync(config.get("auth"), {
                uid: DEV_USER_UID,
                roles: ["admin"],
                scopes: [],
                elevated: -1,
            });
            const { res, setCookieCalls } = fakeRes();

            const result = await strategy.authenticate(fakeReq({ jwt: staleDevToken }), res);

            expect(result?.user?.elevated).toBeGreaterThan(0);
            expect(setCookieCalls).toHaveLength(1);
        });

        it("honors a real (non-dev-uid) caller's unprivileged token as-is, even with no/negative 'elevated' — that's a normal, legitimate state for a real unprivileged user, not staleness.", async () => {
            const realUnprivilegedToken = JWTUtils.createTokenSync(config.get("auth"), {
                uid: "real-user",
                roles: [],
                scopes: [],
                elevated: -1,
            });
            const { res, setCookieCalls } = fakeRes();

            const result = await strategy.authenticate(fakeReq({ jwt: realUnprivilegedToken }), res);

            expect(result?.user?.uid).toBe("real-user");
            expect(result?.user?.elevated).toBe(-1);
            expect(setCookieCalls).toHaveLength(0);
        });

        it("falls back to minting a fresh token when the existing cookie fails to verify.", async () => {
            const { res, setCookieCalls } = fakeRes();

            const result = await strategy.authenticate(fakeReq({ jwt: "not-a-real-token" }), res);

            expect(result?.user?.uid).toBe(DEV_USER_UID);
            expect(setCookieCalls).toHaveLength(1);
        });

        it("still mints successfully when no response object is given (never throws on a missing res).", async () => {
            const result = await strategy.authenticate(fakeReq());
            expect(result?.user?.uid).toBe(DEV_USER_UID);
        });

        it("falls back to a generic label in its log message when the request has no path.", async () => {
            const { res } = fakeRes();
            const result = await strategy.authenticate({ cookies: {} } as any, res);
            expect(result?.user?.uid).toBe(DEV_USER_UID);
        });
    });

    describe("authenticateSync()", () => {
        it("returns undefined when no cookie is present (no synchronous mint path exists).", () => {
            expect(strategy.authenticateSync(fakeReq())).toBeUndefined();
        });

        it("returns the decoded user for an already-valid jwt cookie.", () => {
            const existingToken = JWTUtils.createTokenSync(config.get("auth"), {
                uid: "real-user",
                roles: [],
                scopes: [],
            });
            const result = strategy.authenticateSync(fakeReq({ jwt: existingToken }));
            expect(result?.user?.uid).toBe("real-user");
        });

        it("returns undefined for an invalid cookie.", () => {
            expect(strategy.authenticateSync(fakeReq({ jwt: "garbage" }))).toBeUndefined();
        });
    });
});
