///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
// The webmail (www) and the admin and escrow consoles navigate between their pages on the client with `@rapidrest/react`'s router
// (`router = true` on their routes, a router entry in the client build; see ReactRouteHydration.test.ts for the build side). The webmail
// also has an app shell (`apps/www/_shell.tsx`, its persistent frame), which the library finds by itself. This drives the real routes the
// way a request would, with what needs no page module: a URL that is no page of the app. (Rendering a page imports its TSX source natively,
// which Vitest can't do; the pages themselves are exercised in a browser.) A plugin app beneath a console or the webmail is not routed.
import "reflect-metadata";
import { AdminConsoleRoute as AdminConsoleRouteMongo } from "../../src/mongo/routes/AdminConsoleRoute.js";
import { EscrowConsoleRoute as EscrowConsoleRouteMongo } from "../../src/mongo/routes/EscrowConsoleRoute.js";
import { WwwRoute as WwwRouteMongo } from "../../src/mongo/routes/wwwRoute.js";
import { createPluginUiRoute } from "../../src/plugins/PluginUiRoutes.js";
import { AdminConsoleRoute as AdminConsoleRouteSql } from "../../src/sql/routes/AdminConsoleRoute.js";
import { EscrowConsoleRoute as EscrowConsoleRouteSql } from "../../src/sql/routes/EscrowConsoleRoute.js";
import { AppRoute as WwwRouteSql } from "../../src/sql/routes/wwwRoute.js";

interface FakeResponse {
    code: number;
    body?: string;
    headers: Record<string, string>;
    status(code: number): FakeResponse;
    setHeader(name: string, value: string): FakeResponse;
    getHeader(name: string): string | undefined;
    send(body: string): FakeResponse;
}

function fakeResponse(): FakeResponse {
    const res: FakeResponse = {
        code: 200,
        headers: {},
        status(code) {
            res.code = code;
            return res;
        },
        setHeader(name, value) {
            res.headers[name.toLowerCase()] = value;
            return res;
        },
        getHeader: (name) => res.headers[name.toLowerCase()],
        send(body) {
            res.body = body;
            return res;
        },
    };
    return res;
}

/** A route of `RouteClass` at `prefix`, as it is after `init()`. */
function routeAt(RouteClass: new () => any, prefix: string): any {
    const route: any = new RouteClass();
    route.routePrefix = prefix;
    route.logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    return route;
}

/** What `route.get()` answers when the router asks for the data of the page at `path`. */
async function navigate(route: any, path: string): Promise<{ res: FakeResponse; body: string }> {
    const res = fakeResponse();
    const req = { path, url: path, params: {}, query: {}, cookies: {}, headers: { "x-rapidrest-navigation": "1" }, user: { uid: "u1" } };
    const result = await route.get(req, res);
    return { res, body: typeof result === "string" ? result : (res.body ?? "") };
}

describe("The client-side router of the webmail and the consoles", () => {
    const consoles = [
        { name: "www", prefix: "", page: "calendar", classes: [WwwRouteMongo, WwwRouteSql] },
        { name: "admin", prefix: "/admin", page: "domains", classes: [AdminConsoleRouteMongo, AdminConsoleRouteSql] },
        { name: "escrow", prefix: "/escrow", page: "audit-log", classes: [EscrowConsoleRouteMongo, EscrowConsoleRouteSql] },
    ];

    for (const { name, prefix, page, classes } of consoles) {
        for (const RouteClass of classes) {
            const datastore = RouteClass === classes[0] ? "mongo" : "sql";

            it(`is on for ${name}, and leaves what is no page of it to the browser (${datastore})`, async () => {
                const route = routeAt(RouteClass, prefix);
                expect(route.router).toBe(true);
                expect(route.hydrate).toBe(true);
                // No such page, a wrong-case URL (a 404 on every filesystem since @rapidrest/react 2.0) and a helper file
                // (`_`-prefixed names are never pages): the router is told with the status alone and lets the browser load the
                // URL, so the server renders the error page as it always did.
                for (const missing of [`${prefix}/no-such-page`, `${prefix}/${page.toUpperCase()}`, `${prefix}/_layout`, `${prefix}/_shell`]) {
                    const navigation = await navigate(route, missing);
                    expect(navigation.res.code, missing).toBe(404);
                    expect(JSON.parse(navigation.body)).toEqual({ status: 404 });
                    expect(navigation.res.headers["content-type"]).toBe("application/json");
                    // The same URL is a document without the header: a cache or CDN in front must keep the two apart.
                    expect(navigation.res.headers["vary"]).toContain("X-Rapidrest-Navigation");
                }
            });
        }
    }

    it("is off for a plugin app mounted beneath the webmail or a console, which has no router entry in the build (and so no app shell)", () => {
        const app: any = { id: "demo", host: "admin", mount: "/admin/demo", dir: "apps/demo", sourceDir: "apps/demo", ssrDir: "dist/apps/demo" };
        for (const Base of [WwwRouteMongo, WwwRouteSql, AdminConsoleRouteMongo, AdminConsoleRouteSql, EscrowConsoleRouteMongo, EscrowConsoleRouteSql]) {
            const Plugin = createPluginUiRoute(Base, app, "plugins.x.ui.demo");
            expect(new Plugin().router).toBe(false);
            expect(new Plugin().hydrate).toBe(true);
        }
    });
});
