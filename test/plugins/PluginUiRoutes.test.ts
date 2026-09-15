///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import "reflect-metadata";
import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";
import * as uuid from "uuid";
import { PluginRegistry } from "@rapidmx/restapi";
import { AdminConsoleRoute as AdminConsoleRouteMongo } from "../../src/mongo/routes/AdminConsoleRoute.js";
import { EscrowConsoleRoute as EscrowConsoleRouteMongo } from "../../src/mongo/routes/EscrowConsoleRoute.js";
import { PublicPageRoute as PublicPageRouteMongo } from "../../src/mongo/routes/PublicPageRoute.js";
import { WwwRoute as WwwRouteMongo } from "../../src/mongo/routes/wwwRoute.js";
import { MONGO_PLUGIN_UI_HOSTS } from "../../src/plugins/hosts/mongo.js";
import { SQL_PLUGIN_UI_HOSTS } from "../../src/plugins/hosts/sql.js";
import { PluginClassLoader } from "../../src/plugins/PluginClassLoader.js";
import { resolvePluginUiApps, type InstalledPlugin } from "../../src/plugins/PluginInstaller.js";
import { getPluginNav, manifestNav, type LoadedPluginWithUi } from "../../src/plugins/pluginNav.js";
import { createPluginUiRoute, findRouteCollision, pluginUiRouteName, registeredRoutePaths } from "../../src/plugins/PluginUiRoutes.js";
import { AdminConsoleRoute as AdminConsoleRouteSql } from "../../src/sql/routes/AdminConsoleRoute.js";
import { EscrowConsoleRoute as EscrowConsoleRouteSql } from "../../src/sql/routes/EscrowConsoleRoute.js";
import { PublicPageRoute as PublicPageRouteSql } from "../../src/sql/routes/PublicPageRoute.js";
import { AppRoute as WwwRouteSql } from "../../src/sql/routes/wwwRoute.js";

const FIXTURE = "test/fixtures/ui-plugin";
const FIXTURE_MANIFEST = JSON.parse(fs.readFileSync(path.join(FIXTURE, "package.json"), "utf8")).rapidmx.plugin;

/** The fixture plugin as the installer returns it, with its package directory at `packageDir`. */
function fixturePlugin(packageDir: string, entryUrl: string, extra: Partial<InstalledPlugin> = {}): InstalledPlugin {
    return {
        name: "@rapidmx-test/ui-fixture-plugin",
        version: "1.0.0",
        manifest: FIXTURE_MANIFEST,
        entryUrl,
        packageDir,
        uiApps: resolvePluginUiApps(packageDir, FIXTURE_MANIFEST),
        ...extra,
    };
}

/** Runs `work` as a compiled `node dist/src/server.js` run would see its environment (no tsx or Vitest). */
function asCompiledRuntime<T>(work: () => T): T {
    const originalArgv1 = process.argv[1];
    const originalVitest = process.env.VITEST;
    try {
        process.argv[1] = path.resolve("dist/src/worker.js");
        delete process.env.VITEST;
        return work();
    } finally {
        process.argv[1] = originalArgv1;
        process.env.VITEST = originalVitest;
    }
}

describe("PluginUiRoutes", () => {
    const hosts = [
        { datastore: "mongo", classes: MONGO_PLUGIN_UI_HOSTS, expected: { www: WwwRouteMongo, admin: AdminConsoleRouteMongo, escrow: EscrowConsoleRouteMongo, public: PublicPageRouteMongo } },
        { datastore: "sql", classes: SQL_PLUGIN_UI_HOSTS, expected: { www: WwwRouteSql, admin: AdminConsoleRouteSql, escrow: EscrowConsoleRouteSql, public: PublicPageRouteSql } },
    ];

    for (const { datastore, classes, expected } of hosts) {
        it(`extends each host's ${datastore} base route, mounted only at the app's mount`, () => {
            expect(classes).toEqual(expected);
            for (const [host, base] of Object.entries(expected)) {
                const app = { id: "demo", host: host as any, mount: `/${host}-demo`, dir: "apps/demo", sourceDir: path.resolve("pkg/apps/demo"), ssrDir: path.resolve("pkg/dist/apps/demo") };
                const basePaths = Reflect.getMetadata("rrst:routePaths", base.prototype);
                const clazz = createPluginUiRoute(base, app, "plugins.x.ui.demo");
                expect(Object.getPrototypeOf(clazz.prototype)).toBe(base.prototype);
                expect(Reflect.getMetadata("rrst:routePaths", clazz.prototype)).toEqual([`/${host}-demo`]);
                // The host's own route is untouched.
                expect(Reflect.getMetadata("rrst:routePaths", base.prototype)).toEqual(basePaths);
                const route = new clazz();
                expect(route.appDir).toBe(app.sourceDir);
                expect(route.hydrate).toBe(true);
                expect(asCompiledRuntime(() => new clazz()).appDir).toBe(app.ssrDir);
            }
        });
    }

    it("names a UI app's route after its plugin and app", () => {
        expect(pluginUiRouteName("plugins.rapidmx_booking_plugin", "booking-types")).toBe("plugins.rapidmx_booking_plugin.ui.booking_types");
    });

    it("resolves a plugin page's client bundle from its compiled page in production", () => {
        const packageDir = path.resolve(FIXTURE);
        const [hello] = resolvePluginUiApps(packageDir, FIXTURE_MANIFEST);
        const route = asCompiledRuntime(() => new (createPluginUiRoute(WwwRouteMongo, hello, "plugins.fixture.ui.hello"))());
        route.logger = { warn: vi.fn(), debug: vi.fn(), error: vi.fn(), info: vi.fn() };
        const name = `${FIXTURE}/apps/hello/index.tsx`;
        route.manifest = { [`rapidrest-entry:${name}`]: { file: "assets/hello.js", name, src: `rapidrest-entry:${name}`, isEntry: true, css: ["assets/app.css"] } };
        const originalNodeEnv = process.env.NODE_ENV;
        process.env.NODE_ENV = "production";
        try {
            expect(route.resolveClientUrls(path.join(hello.ssrDir, "index.js"))).toEqual({ js: "/assets/hello.js", css: ["/assets/app.css"] });
        } finally {
            process.env.NODE_ENV = originalNodeEnv;
        }
    });

    it("lists the literal paths registered routes serve, and finds mounts that clash with them", () => {
        class Api {}
        Reflect.defineMetadata("rrst:routePaths", ["/api/mail/messages"], Api.prototype);
        Reflect.defineMetadata("rrst:route", { methods: new Map([["put", "/:id/verification-seal"]]) }, Api.prototype, "seal");
        (Api.prototype as any).seal = () => undefined;
        class ActiveSync {}
        Reflect.defineMetadata("rrst:routePaths", ["/Microsoft-Server-ActiveSync"], ActiveSync.prototype);
        class Mapi {}
        Reflect.defineMetadata("rrst:routePaths", ["/mapi"], Mapi.prototype);
        Reflect.defineMetadata("rrst:route", { methods: new Map([["post", "/emsmdb/*"]]) }, Mapi.prototype, "emsmdb");
        (Mapi.prototype as any).emsmdb = () => undefined;
        const routes = registeredRoutePaths(
            new Map<string, any>([
                ["api", Api],
                ["eas", ActiveSync],
                ["mapi", Mapi],
                ["www", WwwRouteMongo],
                ["admin", AdminConsoleRouteMongo],
                ["not-a-route", class {}],
                ["enum", { A: 1 }],
            ]),
        );
        expect(routes).toEqual(
            expect.arrayContaining([
                { name: "api", path: "/api/mail/messages", react: false },
                { name: "eas", path: "/Microsoft-Server-ActiveSync", react: false },
                { name: "mapi", path: "/mapi/emsmdb", react: false },
                { name: "www", path: "/", react: true },
                { name: "admin", path: "/admin", react: true },
            ]),
        );
        expect(routes.map((route) => route.name)).not.toContain("not-a-route");

        expect(findRouteCollision("/microsoft-server-activesync", routes)?.name).toBe("eas");
        expect(findRouteCollision("/mapi", routes)?.name).toBe("mapi");
        expect(findRouteCollision("/api", routes)?.name).toBe("api");
        // Beneath a React host is fine, beneath anything else isn't; the root host never clashes.
        expect(findRouteCollision("/admin/booking", routes)).toBeUndefined();
        expect(findRouteCollision("/mapi/emsmdb/x", routes)?.name).toBe("mapi");
        expect(findRouteCollision("/book", routes)).toBeUndefined();
        expect(findRouteCollision("/admin", routes)?.name).toBe("admin");
    });

    it("builds plugin navigation from built plugins only, leaving out entries beneath refused mounts", () => {
        const nav = manifestNav(
            {
                apiVersion: 1,
                displayName: "x",
                ui: {
                    settingsSections: [
                        { id: "a", label: "A", href: "/settings/a", icon: "HiOutlineCog" },
                        { id: "b", label: "B", href: "/settings/b/sub?x=1" },
                    ],
                    adminNav: [{ id: "c", label: "C", href: "/admin/c" }],
                },
            },
            ["/settings/b"],
        );
        expect(nav).toEqual({ settingsSections: [{ id: "a", label: "A", href: "/settings/a", icon: "HiOutlineCog" }], adminNav: [{ id: "c", label: "C", href: "/admin/c" }], appRail: [] });
        expect(manifestNav(undefined)).toEqual({ settingsSections: [], adminNav: [], appRail: [] });

        const plugins: LoadedPluginWithUi[] = [
            { name: "built", version: "1.0.0", ui: { status: "built", mounts: [], nav } },
            { name: "failed", version: "1.0.0", ui: { status: "failed", error: "x", mounts: [], nav: { ...nav, appRail: [{ id: "z", label: "Z", href: "/z" }] } } },
            { name: "backend", version: "1.0.0" },
        ];
        expect(getPluginNav(plugins)).toEqual(nav);
        PluginRegistry.setLoaded(plugins);
        try {
            expect(getPluginNav()).toEqual(nav);
        } finally {
            PluginRegistry.setLoaded([]);
        }
    });
});

describe("PluginClassLoader with plugin UI", () => {
    let dir: string;

    beforeEach(() => {
        dir = path.join(process.cwd(), `tmp-ui-classloader-${uuid.v4()}`);
        fs.mkdirSync(path.join(dir, "base", "routes"), { recursive: true });
        fs.writeFileSync(path.join(dir, "base", "routes", "Own.mjs"), "export class OwnRoute {}\n");
        fs.writeFileSync(path.join(dir, "empty.mjs"), "export {};\n");
        // A backend route of another plugin at a mount the fixture wants, in different case.
        fs.writeFileSync(
            path.join(dir, "greeter.mjs"),
            'import "reflect-metadata";\nexport class GreetRoute {}\nReflect.defineMetadata("rrst:routePaths", ["/Greet"], GreetRoute.prototype);\n',
        );
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
        PluginRegistry.setLoaded([]);
    });

    const entry = (file: string) => pathToFileURL(path.join(dir, file)).href;

    for (const [datastore, hosts, www, publicBase] of [
        ["mongo", MONGO_PLUGIN_UI_HOSTS, WwwRouteMongo, PublicPageRouteMongo],
        ["sql", SQL_PLUGIN_UI_HOSTS, WwwRouteSql, PublicPageRouteSql],
    ] as const) {
        it(`registers a ${datastore} route per UI app as plugins.<name>.ui.<id> and records the plugin's UI in PluginRegistry`, async () => {
            const plugin = fixturePlugin(path.resolve(FIXTURE), entry("empty.mjs"));
            const loader = new PluginClassLoader(path.join(dir, "base"), [], [plugin], undefined, undefined, { hosts });
            await loader.load();

            const hello = loader.getClass("plugins.rapidmx_test_ui_fixture_plugin.ui.hello");
            const greet = loader.getClass("plugins.rapidmx_test_ui_fixture_plugin.ui.greet");
            expect(Object.getPrototypeOf(hello.prototype)).toBe(www.prototype);
            expect(Object.getPrototypeOf(greet.prototype)).toBe(publicBase.prototype);
            expect(Reflect.getMetadata("rrst:routePaths", hello.prototype)).toEqual(["/settings/hello"]);
            expect(Reflect.getMetadata("rrst:routePaths", greet.prototype)).toEqual(["/greet"]);
            expect(hello.fqn).toBe("plugins.rapidmx_test_ui_fixture_plugin.ui.hello");
            expect(loader.errors).toEqual([]);

            const expectedNav = {
                settingsSections: [{ id: "hello", label: "Hello", href: "/settings/hello" }],
                adminNav: [],
                appRail: [{ id: "greet", label: "Greet", href: "/greet", icon: "HiOutlineHandRaised" }],
            };
            expect(PluginRegistry.list()).toEqual([
                { name: plugin.name, version: "1.0.0", ui: { status: "built", mounts: ["/settings/hello", "/greet"], nav: expectedNav } },
            ]);

            // The www host's pages (the host itself and the plugin's) get the navigation; the public host's don't.
            const props = await new www().fetchProps({ cookies: {}, user: undefined });
            expect(props.pluginNav).toEqual(expectedNav);
            expect((await new hello().fetchProps({ cookies: {}, user: undefined })).pluginNav).toEqual(expectedNav);
            expect(await new greet().fetchProps({})).not.toHaveProperty("pluginNav");
        });
    }

    it("refuses a UI app whose mount clashes with another plugin's backend route, leaving out its navigation", async () => {
        const logger = { info: vi.fn(), error: vi.fn() };
        const greeter = { name: "@rapidmx/greeter", version: "1.0.0", manifest: { apiVersion: 1, displayName: "Greeter" }, entryUrl: entry("greeter.mjs") };
        const plugin = fixturePlugin(path.resolve(FIXTURE), entry("empty.mjs"));
        const loader = new PluginClassLoader(path.join(dir, "base"), [], [greeter, plugin], logger, undefined, { hosts: MONGO_PLUGIN_UI_HOSTS });
        await loader.load();

        expect(loader.hasClass("plugins.rapidmx_test_ui_fixture_plugin.ui.hello")).toBe(true);
        expect(loader.hasClass("plugins.rapidmx_test_ui_fixture_plugin.ui.greet")).toBe(false);
        expect(loader.errors).toEqual([
            { name: plugin.name, message: "Its UI app greet isn't served: /greet clashes with the route /Greet (plugins.rapidmx_greeter.GreetRoute)." },
        ]);
        expect(logger.error).toHaveBeenCalledWith(expect.stringMatching(/clashes with the route \/Greet/));
        const [, fixture] = PluginRegistry.list() as LoadedPluginWithUi[];
        expect(fixture.ui).toEqual({
            status: "built",
            mounts: ["/settings/hello"],
            nav: { settingsSections: [{ id: "hello", label: "Hello", href: "/settings/hello" }], adminNav: [], appRail: [] },
        });
    });

    it("serves no UI for a plugin whose UI failed to build, or without host routes, but still loads its backend", async () => {
        const failed = fixturePlugin(path.resolve(FIXTURE), entry("empty.mjs"));
        const loader = new PluginClassLoader(path.join(dir, "base"), [], [failed], undefined, undefined, {
            hosts: MONGO_PLUGIN_UI_HOSTS,
            failed: new Map([[failed.name, "The plugin's UI failed to build: boom"]]),
        });
        await loader.load();
        expect([...loader.getClasses().keys()].filter((name) => name.includes(".ui."))).toEqual([]);
        expect(loader.loaded).toHaveLength(1);
        expect(loader.registryEntries()).toEqual([
            { name: failed.name, version: "1.0.0", ui: { status: "failed", error: "The plugin's UI failed to build: boom", mounts: [], nav: { settingsSections: [], adminNav: [], appRail: [] } } },
        ]);

        const hostless = new PluginClassLoader(path.join(dir, "base"), [], [failed]);
        await hostless.load();
        expect(hostless.registryEntries()[0].ui).toEqual(expect.objectContaining({ status: "failed", error: "This server doesn't serve plugin UI." }));
    });

    it("keeps navigation from a plugin without apps, and drops entries beneath mounts refused before building", async () => {
        const navOnly = {
            name: "@rapidmx/nav-only",
            version: "1.0.0",
            manifest: { apiVersion: 1, displayName: "Nav", ui: { adminNav: [{ id: "x", label: "X", href: "/admin/x" }], settingsSections: [{ id: "y", label: "Y", href: "/settings/y" }] } },
            entryUrl: entry("empty.mjs"),
            uiApps: [],
        };
        const loader = new PluginClassLoader(path.join(dir, "base"), [], [navOnly], undefined, undefined, {
            hosts: MONGO_PLUGIN_UI_HOSTS,
            refusedMounts: new Map([[navOnly.name, ["/settings/y"]]]),
        });
        await loader.load();
        expect(loader.registryEntries()[0].ui).toEqual({ status: "built", mounts: [], nav: { settingsSections: [], adminNav: [{ id: "x", label: "X", href: "/admin/x" }], appRail: [] } });
    });
});
