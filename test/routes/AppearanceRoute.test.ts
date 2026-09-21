///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
// The appearance preferences route and background send, as this server mounts them: restapi's handlers inherited at the
// paths the web client calls, the model classes they need set, and the signed-in user's saved appearance handed to the
// page as a prop.
import "reflect-metadata";
import { AppearanceRoute as AppearanceRouteMongo } from "../../src/mongo/routes/AppearanceRoute.js";
import { MessageRoute as MessageRouteMongo } from "../../src/mongo/routes/MessageRoute.js";
import { WwwRoute as WwwRouteMongo } from "../../src/mongo/routes/wwwRoute.js";
import { AppearanceRoute as AppearanceRouteSql } from "../../src/sql/routes/AppearanceRoute.js";
import { MessageRoute as MessageRouteSql } from "../../src/sql/routes/MessageRoute.js";
import { AppRoute as WwwRouteSql } from "../../src/sql/routes/wwwRoute.js";
import config from "../../src/config.mongo.js";
import sqlConfig from "../../src/config.sql.js";
import { DEFAULT_APPEARANCE_BACKGROUND_MAX_BYTES } from "../../src/config.defaults.js";

/** Every `method path` pair the route class declares, from its handlers' `rrst:route` metadata. */
function declaredMethods(routeClass: new () => any): string[] {
    const result: string[] = [];
    const seen = new Set<string>();
    for (let proto = routeClass.prototype; proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
        for (const key of Object.getOwnPropertyNames(proto)) {
            if (seen.has(key)) {
                continue;
            }
            seen.add(key);
            const route = Reflect.getMetadata("rrst:route", routeClass.prototype, key);
            for (const [method, path] of (route?.methods as Map<string, string> | undefined) ?? []) {
                result.push(`${method} ${path}`);
            }
        }
    }
    return result;
}

describe("appearance preferences", () => {
    it.each([
        ["mongo", AppearanceRouteMongo],
        ["sql", AppearanceRouteSql],
    ])("%s AppearanceRoute serves the preferences and the background image under mail/preferences/appearance", (_name, routeClass) => {
        expect(Reflect.getMetadata("rrst:routePaths", routeClass.prototype)).toEqual(["/api/mail/preferences/appearance"]);
        // `@Get()`/`@Put()` declare the route's own base path as an empty path.
        expect(declaredMethods(routeClass).sort()).toEqual(["delete /background", "get ", "get /background/:version", "post /background", "put "]);
        expect(new routeClass().appearanceClass).toBeTypeOf("function");
    });

    it.each([
        ["mongo", MessageRouteMongo],
        ["sql", MessageRouteSql],
    ])("%s MessageRoute can send in the background: POST /:id/send is inherited and its ScheduledSendJob is set", (_name, routeClass) => {
        expect(declaredMethods(routeClass)).toContain("post /:id/send");
        expect(new routeClass().sendJobClass).toBeTypeOf("function");
    });

    it.each([
        ["mongo", config],
        ["sql", sqlConfig],
    ])("%s config caps a background image at 8 MB and sizes the send pool", (_name, conf) => {
        expect(conf.get("mail:preferences:background_max_bytes")).toBe(DEFAULT_APPEARANCE_BACKGROUND_MAX_BYTES);
        expect(DEFAULT_APPEARANCE_BACKGROUND_MAX_BYTES).toBe(8 * 1024 * 1024);
        expect(conf.get("mail:jobs:scheduled_send:concurrency")).toBe(4);
        expect(conf.get("mail:jobs:scheduled_send:drain_ms")).toBe(15_000);
    });

    describe.each([
        ["mongo", WwwRouteMongo],
        ["sql", WwwRouteSql],
    ])("%s page props", (_name, wwwClass) => {
        const saved = { version: 1, mode: "dark", colors: { primary: "#112233" }, updatedAt: "2026-09-21T10:00:00.000Z" };
        const pageProps = async (objectFactory: any, user: any, logger?: any) => {
            const route: any = new wwwClass();
            route.brandingObjectFactory = objectFactory;
            route.appearanceLogger = logger;
            return await route.fetchProps({ cookies: {}, user });
        };
        const factoryWith = (row: any) => ({
            newInstance: async () => ({ findOne: async () => row }),
        });

        it("carries the signed-in user's saved appearance as `appearance`", async () => {
            const props = await pageProps(factoryWith({ userUid: "u1", mode: "dark", colors: { primary: "#112233" }, dateModified: new Date(saved.updatedAt) }), { uid: "u1" });

            expect(props.appearance).toEqual(saved);
        });

        it("has no `appearance` for a user who has saved none, and for a visitor who is not signed in", async () => {
            expect((await pageProps(factoryWith(undefined), { uid: "u1" })).appearance).toBeUndefined();
            expect((await pageProps(factoryWith({ mode: "dark" }), undefined)).appearance).toBeUndefined();
        });

        it("never fails the page: a datastore error is logged at debug level and the prop is left out", async () => {
            const debug = vi.fn();
            const broken = { newInstance: async () => ({ findOne: async () => Promise.reject(new Error("datastore down")) }) };

            const props = await pageProps(broken, { uid: "u1" }, { debug });

            expect(props.appearance).toBeUndefined();
            expect(props.trustedRoles).toEqual(["admin"]);
            expect(debug).toHaveBeenCalledWith(expect.stringContaining("datastore down"));
        });
    });
});
