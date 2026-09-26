///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
// Production-mode hydration for every ReactRoute this server mounts: each page an app ships must have a client
// entry in the Vite build (vite.config.ts's appDir list), and ReactRoute must find that entry from the compiled
// page module a `node dist/src/server.js` run actually imports. A fixture manifest is built from vite.config.ts's
// own hydration entries, named the way Vite names them, so this needs no real Vite build.
import * as fs from "fs";
import * as path from "path";
import viteConfig from "../../vite.config.js";
import { AdminConsoleRoute as AdminConsoleRouteMongo } from "../../src/mongo/routes/AdminConsoleRoute.js";
import { EscrowConsoleRoute as EscrowConsoleRouteMongo } from "../../src/mongo/routes/EscrowConsoleRoute.js";
import { WwwRoute as WwwRouteMongo } from "../../src/mongo/routes/wwwRoute.js";
import { AdminConsoleRoute as AdminConsoleRouteSql } from "../../src/sql/routes/AdminConsoleRoute.js";
import { EscrowConsoleRoute as EscrowConsoleRouteSql } from "../../src/sql/routes/EscrowConsoleRoute.js";
import { AppRoute as WwwRouteSql } from "../../src/sql/routes/wwwRoute.js";

type ManifestEntry = { file: string; name: string; src: string; isEntry: boolean };

const WEB_CLIENT = "node_modules/@rapidmx/web-client";

/** Each route's page sources, and the directory its compiled page modules are imported from in production. */
const APPS: Array<{ route: string; classes: Array<new () => any>; sourceDir: string; compiledDir: string; appDir: string }> = [
    {
        route: "WwwRoute",
        classes: [WwwRouteMongo, WwwRouteSql],
        sourceDir: `${WEB_CLIENT}/apps/www`,
        compiledDir: `${WEB_CLIENT}/dist/apps/www`,
        appDir: `${WEB_CLIENT}/dist/apps/www`,
    },
    {
        route: "AdminConsoleRoute",
        classes: [AdminConsoleRouteMongo, AdminConsoleRouteSql],
        sourceDir: `${WEB_CLIENT}/apps/admin`,
        compiledDir: `${WEB_CLIENT}/dist/apps/admin`,
        appDir: `${WEB_CLIENT}/dist/apps/admin`,
    },
    {
        route: "EscrowConsoleRoute",
        classes: [EscrowConsoleRouteMongo, EscrowConsoleRouteSql],
        sourceDir: `${WEB_CLIENT}/apps/escrow`,
        compiledDir: `${WEB_CLIENT}/dist/apps/escrow`,
        appDir: `${WEB_CLIENT}/dist/apps/escrow`,
    },
];

/** Page files under `dir` by @rapidrest/react's convention: `.tsx` files at any depth, skipping `_`-prefixed names. */
function pageFiles(dir: string, rel: string = ""): string[] {
    const pages: string[] = [];
    for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
        if (entry.name.startsWith("_")) {
            continue;
        }
        const entryRel = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
            pages.push(...pageFiles(dir, entryRel));
        } else if (entry.name.endsWith(".tsx")) {
            pages.push(entryRel);
        }
    }
    return pages;
}

/** Vite's manifest entries for vite.config.ts's hydration inputs: keyed by the virtual id, named with `[`/`]` as `_`. */
async function fixtureManifest(): Promise<Record<string, ManifestEntry>> {
    const config: any = await viteConfig();
    const plugin = config.plugins.flat().find((p: any) => p?.name === "rapidrest-hydration");
    const { input } = plugin.options({});
    const manifest: Record<string, ManifestEntry> = {};
    for (const key of Object.keys(input)) {
        const name = key.replace(/[[\]]/g, "_");
        manifest[`rapidrest-entry:${key}`] = { file: `assets/${name}-hash.js`, name, src: `rapidrest-entry:${key}`, isEntry: true };
    }
    return manifest;
}

/** Constructs `RouteClass` the way a compiled `node dist/src/server.js` run would (no tsx or Vitest context). */
function constructForCompiledRuntime(RouteClass: new () => any): any {
    const originalArgv1 = process.argv[1];
    const originalVitest = process.env.VITEST;
    try {
        process.argv[1] = path.resolve("dist/src/worker.js");
        delete process.env.VITEST;
        return new RouteClass();
    } finally {
        process.argv[1] = originalArgv1;
        process.env.VITEST = originalVitest;
    }
}

describe("ReactRoute production hydration", () => {
    let manifest: Record<string, ManifestEntry>;
    let originalNodeEnv: string | undefined;

    beforeAll(async () => {
        manifest = await fixtureManifest();
    });

    beforeEach(() => {
        originalNodeEnv = process.env.NODE_ENV;
    });

    afterEach(() => {
        process.env.NODE_ENV = originalNodeEnv;
    });

    for (const app of APPS) {
        for (const RouteClass of app.classes) {
            it(`resolves a client bundle for every ${app.sourceDir} page from its compiled module (${app.route}, ${RouteClass === app.classes[0] ? "mongo" : "sql"})`, () => {
                const route = constructForCompiledRuntime(RouteClass);
                expect(route.appDir).toBe(app.appDir);
                const warn = vi.fn();
                route.logger = { warn, debug: vi.fn(), error: vi.fn(), info: vi.fn() };
                route.manifest = manifest;
                process.env.NODE_ENV = "production";

                const pages = pageFiles(app.sourceDir);
                expect(pages).toContain("index.tsx");
                for (const page of pages) {
                    const compiledPage = path.resolve(app.compiledDir, page.replace(/\.tsx$/, ".js"));
                    const expected = `/assets/${`${app.sourceDir}/${page}`.replace(/[[\]]/g, "_")}-hash.js`;
                    expect(route.resolveClientUrls(compiledPage).js, page).toBe(expected);
                }
                expect(warn).not.toHaveBeenCalled();
            });

            it(`navigates between the pages of ${app.sourceDir} on the client (${app.route}, ${RouteClass === app.classes[0] ? "mongo" : "sql"})`, () => {
                const route = constructForCompiledRuntime(RouteClass);
                expect(route.router).toBe(true);
                route.logger = { warn: vi.fn(), debug: vi.fn(), error: vi.fn(), info: vi.fn() };
                route.manifest = manifest;
                process.env.NODE_ENV = "production";

                // Every page is served the router entry of its app, found from the compiled module the server imports.
                const expected = `/assets/${app.sourceDir}/__router-hash.js`;
                const pages = pageFiles(app.sourceDir);
                expect(pages).toContain("index.tsx");
                for (const page of pages) {
                    const compiledPage = path.resolve(app.compiledDir, page.replace(/\.tsx$/, ".js"));
                    expect(route.resolveRouterAssets(compiledPage).entry, page).toBe(expected);
                }
            });
        }
    }
});
