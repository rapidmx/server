///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
import config from "../../src/config.mongo.js";
import { ObjectFactory } from "@rapidrest/service-core";
import { JWTUtils, Logger } from "@rapidrest/core";
import { DevImpersonationRoute } from "../../src/dev/DevImpersonationRoute.js";

function fakeReq(cookies: Record<string, string> = {}): any {
    return { cookies };
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

describe("DevImpersonationRoute Tests", () => {
    const objectFactory: ObjectFactory = new ObjectFactory(config, Logger());
    let route: DevImpersonationRoute;

    beforeAll(async () => {
        route = await objectFactory.newInstance<DevImpersonationRoute>(DevImpersonationRoute);
    });

    describe("impersonate()", () => {
        it("throws INVALID_REQUEST when userUid is missing from the body.", () => {
            const { res } = fakeRes();
            expect(() => route.impersonate({} as any, fakeReq(), res, { uid: "admin", roles: [], scopes: [] })).toThrow();
        });

        it("throws INTERNAL_ERROR when the auth config is unavailable.", () => {
            const bare = new DevImpersonationRoute();
            const { res } = fakeRes();
            expect(() =>
                bare.impersonate({ userUid: "u1" }, fakeReq(), res, { uid: "admin", roles: [], scopes: [] }),
            ).toThrow();
        });

        it("mints an unprivileged token for the target uid and sets it as the jwt cookie.", () => {
            const { res, setCookieCalls } = fakeRes();

            const result = route.impersonate({ userUid: "target-user" }, fakeReq(), res, {
                uid: "admin",
                roles: ["admin"],
                scopes: [],
            });

            expect(result.user).toEqual({ uid: "target-user", roles: [], scopes: [] });
            const decoded = JWTUtils.decodeTokenSync(config.get("auth"), result.token);
            expect(decoded.profile.uid).toBe("target-user");
            expect(decoded.profile.roles).toEqual([]);
            expect(setCookieCalls).toHaveLength(1);
            expect(setCookieCalls[0]).toMatch(new RegExp(`^jwt=${result.token}; Path=/; SameSite=Lax$`));
        });

        it("stashes the caller's current jwt cookie under jwt_impersonator when one is present.", () => {
            const { res, setCookieCalls } = fakeRes();

            route.impersonate(
                { userUid: "target-user" },
                fakeReq({ jwt: "current-token" }),
                res,
                { uid: "admin", roles: ["admin"], scopes: [] },
            );

            expect(setCookieCalls).toHaveLength(2);
            expect(setCookieCalls[0]).toBe("jwt_impersonator=current-token; Path=/; SameSite=Lax");
        });

        it("does not stash jwt_impersonator when the caller has no current jwt cookie.", () => {
            const { res, setCookieCalls } = fakeRes();

            route.impersonate({ userUid: "target-user" }, fakeReq(), res, { uid: "admin", roles: ["admin"], scopes: [] });

            expect(setCookieCalls).toHaveLength(1);
        });

        it("works even when no caller user is provided (never throws on a missing @User).", () => {
            const { res } = fakeRes();
            expect(() => route.impersonate({ userUid: "target-user" }, fakeReq(), res)).not.toThrow();
        });
    });

    describe("stopImpersonating()", () => {
        // Regression: mirrors the real BaseImpersonationRoute's own GET->POST fix - a state-changing GET
        // is exploitable via a bare navigation, bypassing CSRF defenses entirely (they only ever apply to
        // non-safe methods). Asserted off the route metadata so a regression back to @Get is caught even
        // by a test that never spins up a real server.
        it("is registered as POST, not GET, at the framework metadata level.", () => {
            const metadata: any = Reflect.getMetadata(
                "rrst:route",
                DevImpersonationRoute.prototype,
                "stopImpersonating",
            );
            expect(metadata.methods.has("post")).toBe(true);
            expect(metadata.methods.has("get")).toBe(false);
        });

        it("returns restored:false and sets no cookies when there is no jwt_impersonator cookie.", () => {
            const { res, setCookieCalls } = fakeRes();
            const result = route.stopImpersonating(fakeReq(), res, { uid: "target-user", roles: [], scopes: [] });
            expect(result).toEqual({ restored: false });
            expect(setCookieCalls).toHaveLength(0);
        });

        it("restores the stashed jwt and clears jwt_impersonator when one is present.", () => {
            const { res, setCookieCalls } = fakeRes();

            const result = route.stopImpersonating(
                fakeReq({ jwt_impersonator: "admin-token" }),
                res,
                { uid: "target-user", roles: [], scopes: [] },
            );

            expect(result).toEqual({ restored: true });
            expect(setCookieCalls).toHaveLength(2);
            expect(setCookieCalls[0]).toBe("jwt=admin-token; Path=/; SameSite=Lax");
            expect(setCookieCalls[1]).toBe("jwt_impersonator=; Path=/; Max-Age=0; SameSite=Lax");
        });

        it("works even when no caller user is provided (never throws on a missing @User).", () => {
            const { res } = fakeRes();
            expect(() => route.stopImpersonating(fakeReq({ jwt_impersonator: "admin-token" }), res)).not.toThrow();
        });
    });
});
