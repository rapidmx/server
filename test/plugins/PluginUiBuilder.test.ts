///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import fs from "fs";
import os from "os";
import path from "path";
import * as uuid from "uuid";
import { resolvePluginUiApps, type InstalledPlugin } from "../../src/plugins/PluginInstaller.js";
import { PluginUiBuilder, UI_BUILD_DIR } from "../../src/plugins/PluginUiBuilder.js";

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function write(file: string, content: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
}

describe("PluginUiBuilder", () => {
    let appRoot: string;
    let pluginsDir: string;
    let buildRoot: string;

    beforeEach(() => {
        appRoot = path.join(os.tmpdir(), `rapidmx-ui-build-${uuid.v4()}`);
        pluginsDir = path.join(appRoot, "plugins");
        buildRoot = path.join(pluginsDir, UI_BUILD_DIR);
        write(path.join(appRoot, "package.json"), JSON.stringify({ name: "server", version: "1.0.0" }));
        write(path.join(appRoot, "node_modules", "@rapidmx", "web-client", "package.json"), JSON.stringify({ version: "0.4.0" }));
        write(path.join(appRoot, "node_modules", "@rapidmx", "react-shared", "package.json"), JSON.stringify({ version: "0.4.0" }));
        write(path.join(appRoot, "core", "www", "index.tsx"), "export default () => null;\n");
        write(path.join(appRoot, "public", "favicon.ico"), "icon");
    });

    afterEach(() => {
        fs.rmSync(appRoot, { recursive: true, force: true });
        vi.restoreAllMocks();
    });

    /** Installs a fake plugin with one UI app on `host` (or none), returning it as the installer would. */
    function plugin(name: string, options: { version?: string; integrity?: string | null; mount?: string; ui?: boolean } = {}): InstalledPlugin {
        const packageDir = path.join(pluginsDir, "node_modules", ...name.split("/"));
        const id = name.split("/").pop()!;
        const manifest: any = {
            apiVersion: 1,
            displayName: name,
            ...(options.ui === false ? {} : { ui: { apps: [{ id, host: "www", mount: options.mount ?? `/settings/${id}`, dir: "apps/page" }] } }),
        };
        write(path.join(packageDir, "apps", "page", "index.tsx"), `export default () => "${name}";\n`);
        write(path.join(packageDir, "dist", "apps", "page", "index.js"), `export default () => "${name}";\n`);
        return {
            name,
            version: options.version ?? "1.0.0",
            manifest,
            entryUrl: "",
            packageDir,
            ...(options.integrity === null ? {} : { integrity: options.integrity ?? `sha512-${name}` }),
            uiApps: resolvePluginUiApps(packageDir, manifest),
        };
    }

    /** A Vite stand-in that writes a manifest (and a bundle) to the configured outDir, or fails for `failWhen`. */
    function fakeBuild(failWhen?: (config: any) => Error | undefined) {
        return vi.fn(async (config: any) => {
            const failure = failWhen?.(config);
            if (failure) {
                throw failure;
            }
            write(path.join(config.build.outDir, ".vite", "manifest.json"), JSON.stringify({ apps: config.appDirs }));
            write(path.join(config.build.outDir, "assets", "page.js"), "");
        });
    }

    const createConfig = vi.fn(async (options: any) => ({ appDirs: options.extraAppDirs, stylesheets: options.stylesheets, build: { outDir: options.outDir, manifest: true } }));

    function builder(build: any, extra: Record<string, any> = {}) {
        return new PluginUiBuilder({ pluginsDir, appRoot, logger, coreAppDirs: ["core/www"], createConfig, build, ...extra });
    }

    it("keeps the prebuilt bundles and builds nothing without plugin UI, keeping old builds for when plugins return", async () => {
        write(path.join(buildRoot, "a".repeat(64), ".vite", "manifest.json"), "{}");
        write(path.join(buildRoot, `failed-${"c".repeat(64)}.json`), "{}");
        const staleTemp = path.join(buildRoot, ".tmp-stale");
        fs.mkdirSync(staleTemp, { recursive: true });
        const longAgo = new Date(Date.now() - 2 * 60 * 60_000);
        fs.utimesSync(staleTemp, longAgo, longAgo);
        const build = fakeBuild();
        const result = await builder(build).build([plugin("@x/backend-only", { ui: false })]);
        expect(result).toEqual({ built: [], failed: [] });
        expect(build).not.toHaveBeenCalled();
        expect(fs.existsSync(path.join(buildRoot, "a".repeat(64)))).toBe(true);
        expect(fs.existsSync(path.join(buildRoot, `failed-${"c".repeat(64)}.json`))).toBe(false);
        expect(fs.existsSync(staleTemp)).toBe(false);
    });

    it("hashes the same inputs the same way, and differently when a version, integrity, app or patch changes", () => {
        const one = plugin("@x/one");
        const hash = builder(fakeBuild()).computeHash([one]);
        expect(builder(fakeBuild()).computeHash([one])).toBe(hash);
        expect(hash).toMatch(/^[0-9a-f]{64}$/);
        expect(builder(fakeBuild()).computeHash([{ ...one, version: "1.0.1" }])).not.toBe(hash);
        expect(builder(fakeBuild()).computeHash([{ ...one, integrity: "sha512-other" }])).not.toBe(hash);
        expect(builder(fakeBuild()).computeHash([{ ...one, uiApps: [{ ...one.uiApps![0], mount: "/settings/two" }] }])).not.toBe(hash);
        // Order of the plugins doesn't matter.
        const two = plugin("@x/two");
        expect(builder(fakeBuild()).computeHash([one, two])).toBe(builder(fakeBuild()).computeHash([two, one]));

        write(path.join(appRoot, "node_modules", "@rapidmx", "web-client", "package.json"), JSON.stringify({ version: "0.5.0" }));
        const upgraded = builder(fakeBuild()).computeHash([one]);
        expect(upgraded).not.toBe(hash);
        write(
            path.join(appRoot, "yarn.lock"),
            `"@rapidmx/web-client@patch:@rapidmx/web-client@npm%3A0.4.0#~/.yarn/patches/x.patch":\n  version: 0.4.0\n  resolution: "@rapidmx/web-client@patch:@rapidmx/web-client@npm%3A0.4.0#~/.yarn/patches/x.patch::version=0.4.0&hash=abc123"\n`,
        );
        expect(builder(fakeBuild()).computeHash([one])).not.toBe(upgraded);
    });

    it("hashes a plugin without integrity by the content of its apps", () => {
        const local = plugin("@x/local", { integrity: null });
        const hash = builder(fakeBuild()).computeHash([local]);
        expect(builder(fakeBuild()).computeHash([local])).toBe(hash);
        write(path.join(local.uiApps![0].sourceDir, "index.tsx"), "export default () => 'changed';\n");
        expect(builder(fakeBuild()).computeHash([local])).not.toBe(hash);
    });

    it("builds into a temporary folder, moves it into place, and prunes other builds and stale temporary folders", async () => {
        const one = plugin("@x/one");
        const old = path.join(buildRoot, "b".repeat(64));
        write(path.join(old, ".vite", "manifest.json"), "{}");
        const staleTemp = path.join(buildRoot, ".tmp-stale");
        const freshTemp = path.join(buildRoot, ".tmp-fresh");
        fs.mkdirSync(staleTemp, { recursive: true });
        fs.mkdirSync(freshTemp, { recursive: true });
        const longAgo = new Date(Date.now() - 2 * 60 * 60_000);
        fs.utimesSync(staleTemp, longAgo, longAgo);

        let outDir: string = "";
        let cssFile: string = "";
        const build = fakeBuild((config) => {
            outDir = config.build.outDir;
            cssFile = config.stylesheets[0].css;
            // Built into a temporary folder, from the plugin's sources relative to the server, with its public folder.
            expect(path.basename(outDir)).toMatch(/^\.tmp-/);
            expect(config.appDirs).toEqual(["plugins/node_modules/@x/one/apps/page"]);
            expect(config.stylesheets).toEqual([{ appDir: "plugins/node_modules/@x/one/apps/page", css: path.join(`${outDir}-css`, "plugin-ui.css") }]);
            expect(config.root).toBe(appRoot);
            expect(config.publicDir).toBe(path.join(appRoot, "public"));
            expect(config.configFile).toBe(false);
            const css = fs.readFileSync(cssFile, "utf8");
            expect(css).toContain('@import "../../../node_modules/@rapidmx/web-client/apps/shared/styles/app.css";');
            expect(css).toContain('@source "../../node_modules/@x/one";');
            return undefined;
        });
        const result = await builder(build).build([one]);

        const hash = builder(build).computeHash([one]);
        expect(result).toEqual({ manifestPath: path.join(buildRoot, hash, ".vite", "manifest.json"), hash, built: ["@x/one"], failed: [] });
        expect(fs.existsSync(result.manifestPath!)).toBe(true);
        expect(fs.existsSync(outDir)).toBe(false);
        expect(fs.existsSync(cssFile)).toBe(false);
        expect(fs.existsSync(old)).toBe(false);
        expect(fs.existsSync(staleTemp)).toBe(false);
        expect(fs.existsSync(freshTemp)).toBe(true);
    });

    it("reuses a completed build without running Vite", async () => {
        const one = plugin("@x/one");
        const hash = builder(fakeBuild()).computeHash([one]);
        write(path.join(buildRoot, hash, ".vite", "manifest.json"), "{}");
        const build = fakeBuild();
        const result = await builder(build).build([one]);
        expect(build).not.toHaveBeenCalled();
        expect(result.manifestPath).toBe(path.join(buildRoot, hash, ".vite", "manifest.json"));
        expect(result.built).toEqual(["@x/one"]);
    });

    it("uses a build another start completed first, instead of failing to move its own into place", async () => {
        const one = plugin("@x/one");
        const hash = builder(fakeBuild()).computeHash([one]);
        const build = fakeBuild((config) => {
            write(path.join(buildRoot, hash, ".vite", "manifest.json"), '{"winner":true}');
            write(path.join(buildRoot, hash, "assets", "other.js"), "");
            write(path.join(config.build.outDir, "assets", "mine.js"), "");
            return undefined;
        });
        const result = await builder(build).build([one]);
        expect(result.manifestPath).toBe(path.join(buildRoot, hash, ".vite", "manifest.json"));
        expect(JSON.parse(fs.readFileSync(result.manifestPath!, "utf8"))).toEqual({ winner: true });
        expect(fs.readdirSync(buildRoot).filter((entry) => entry.startsWith(".tmp-"))).toEqual([]);
    });

    it("fails a build that writes no manifest, keeping the prebuilt bundles", async () => {
        const build = vi.fn(async () => undefined);
        const result = await builder(build).build([plugin("@x/one")]);
        expect(result.manifestPath).toBeUndefined();
        expect(result.failed).toEqual([{ name: "@x/one", message: expect.stringMatching(/without writing a Vite manifest/) }]);
    });

    it("retries without the plugin a failure names, and remembers it for the same plugin set", async () => {
        const good = plugin("@x/good");
        const bad = plugin("@x/bad");
        const failWhenBad = (config: any) =>
            config.appDirs.some((dir: string) => dir.includes("@x/bad"))
                ? Object.assign(new Error("Could not resolve \"./missing\""), { id: path.join(bad.packageDir!, "apps", "page", "index.tsx") })
                : undefined;
        const build = fakeBuild(failWhenBad);
        const result = await builder(build).build([good, bad]);
        expect(build).toHaveBeenCalledTimes(2);
        expect(result.built).toEqual(["@x/good"]);
        expect(result.failed).toEqual([{ name: "@x/bad", message: expect.stringMatching(/failed to build: Could not resolve/) }]);
        expect(result.manifestPath).toBe(path.join(buildRoot, builder(build).computeHash([good]), ".vite", "manifest.json"));

        // The next start with the same plugins skips the failing build altogether.
        const next = fakeBuild(failWhenBad);
        const again = await builder(next).build([good, bad]);
        expect(next).not.toHaveBeenCalled();
        expect(again.built).toEqual(["@x/good"]);
        expect(again.failed).toEqual(result.failed);
    });

    it("attributes a failure by the plugin's package path in node_modules, even in another error of the build", async () => {
        const bad = plugin("@x/bad");
        const build = fakeBuild(() => Object.assign(new Error("Build failed with 1 error"), { errors: [{ message: "x", loc: { file: "C:\\app\\plugins\\node_modules\\@x\\bad\\apps\\page\\index.tsx" } }] }));
        const result = await builder(build).build([bad]);
        expect(result.built).toEqual([]);
        expect(result.manifestPath).toBeUndefined();
        expect(result.failed.map((failure) => failure.name)).toEqual(["@x/bad"]);
        expect(fs.readdirSync(buildRoot).filter((entry) => entry.startsWith("failed-"))).toHaveLength(1);
    });

    it("drops all plugin UI when a failure can't be attributed to a plugin", async () => {
        const build = fakeBuild(() => new Error("JavaScript heap out of memory"));
        const result = await builder(build).build([plugin("@x/one"), plugin("@x/two")]);
        expect(build).toHaveBeenCalledTimes(1);
        expect(result).toEqual({
            built: [],
            failed: [
                { name: "@x/one", message: "The plugin's UI failed to build: JavaScript heap out of memory" },
                { name: "@x/two", message: "The plugin's UI failed to build: JavaScript heap out of memory" },
            ],
        });
        expect(logger.error).toHaveBeenCalledWith(expect.stringMatching(/no plugin UI is served/));
    });

    it("builds nothing when the server's own app sources are missing", async () => {
        const build = fakeBuild();
        const result = await builder(build, { coreAppDirs: ["core/www", "core/missing"] }).build([plugin("@x/one")]);
        expect(build).not.toHaveBeenCalled();
        expect(result.failed).toEqual([{ name: "@x/one", message: expect.stringMatching(/app sources are missing \(core\/missing\)/) }]);
    });

    it("leaves out a plugin whose app sources or compiled pages are missing", async () => {
        const noSources = plugin("@x/no-sources");
        fs.rmSync(noSources.uiApps![0].sourceDir, { recursive: true });
        const noCompiled = plugin("@x/no-compiled");
        fs.rmSync(noCompiled.uiApps![0].ssrDir, { recursive: true });
        const good = plugin("@x/good");
        const build = fakeBuild();

        // Compiled pages only matter outside tsx and test runners.
        const originalVitest = process.env.VITEST;
        const originalArgv1 = process.argv[1];
        delete process.env.VITEST;
        process.argv[1] = path.join(appRoot, "dist", "src", "worker.js");
        let result;
        try {
            result = await builder(build).build([noSources, noCompiled, good]);
        } finally {
            process.env.VITEST = originalVitest;
            process.argv[1] = originalArgv1;
        }
        expect(result.built).toEqual(["@x/good"]);
        expect(result.failed).toEqual([
            { name: "@x/no-sources", message: "Its UI app no-sources has no sources at apps/page." },
            { name: "@x/no-compiled", message: "Its UI app no-compiled has no compiled pages at dist/apps/page." },
        ]);
    });

    it("copies the prebuilt static files into the build when the server has no public folder", async () => {
        fs.rmSync(path.join(appRoot, "public"), { recursive: true });
        write(path.join(appRoot, "dist", "public", "fonts", "font.ttf"), "font");
        write(path.join(appRoot, "dist", "public", "assets", "old.js"), "");
        write(path.join(appRoot, "dist", "public", ".vite", "manifest.json"), "{}");
        const build = fakeBuild((config) => {
            expect(config.publicDir).toBe(false);
            return undefined;
        });
        const result = await builder(build, { prebuiltOutDir: "dist/public" }).build([plugin("@x/one")]);
        const outDir = path.dirname(path.dirname(result.manifestPath!));
        expect(fs.readFileSync(path.join(outDir, "fonts", "font.ttf"), "utf8")).toBe("font");
        expect(fs.existsSync(path.join(outDir, "assets", "old.js"))).toBe(false);
    });
});

describe("PluginUiBuilder with Vite", () => {
    let pluginsDir: string;

    afterEach(() => {
        fs.rmSync(pluginsDir, { recursive: true, force: true });
    });

    it("builds a plugin's apps with the core apps: an entry per page, and a stylesheet with the plugin's classes", async () => {
        // Inside the server's directory, as in production: Vite's root, and where app sources and packages resolve from.
        pluginsDir = path.join(process.cwd(), `tmp-ui-vite-${uuid.v4()}`);
        const packageDir = path.resolve("test/fixtures/ui-plugin");
        const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf8")).rapidmx.plugin;
        const fixture: InstalledPlugin = { name: "@rapidmx-test/ui-fixture-plugin", version: "1.0.0", manifest, entryUrl: "", packageDir, uiApps: resolvePluginUiApps(packageDir, manifest) };

        const result = await new PluginUiBuilder({ pluginsDir, appRoot: process.cwd(), logger }).build([fixture]);
        expect(result.failed).toEqual([]);
        expect(result.built).toEqual([fixture.name]);
        const outDir = path.dirname(path.dirname(result.manifestPath!));
        const viteManifest: Record<string, any> = JSON.parse(fs.readFileSync(result.manifestPath!, "utf8"));
        const byName = (name: string) => Object.values(viteManifest).find((entry: any) => entry.name === name);
        // A page's stylesheets can sit on chunks it imports rather than on the entry itself (strict execution order
        // moves shared CSS there), so collect them the way ReactRoute.resolveClientUrls() does.
        const stylesheetsOf = (chunk: any, seen = new Set<string>()): string[] => [
            ...(chunk.css ?? []),
            ...(chunk.imports ?? [])
                .filter((key: string) => !seen.has(key) && seen.add(key))
                .flatMap((key: string) => stylesheetsOf(viteManifest[key], seen)),
        ];
        for (const page of ["apps/hello/index.tsx", "apps/greet/index.tsx", "apps/greet/_name_.tsx"]) {
            const entry = byName(`test/fixtures/ui-plugin/${page}`);
            expect(entry, page).toBeDefined();
            const css = stylesheetsOf(entry).map((file) => fs.readFileSync(path.join(outDir, file), "utf8")).join("\n");
            expect(css, page).toContain("bg-fuchsia-700");
        }
        expect(byName("node_modules/@rapidmx/web-client/apps/www/index.tsx")).toBeDefined();
        expect(fs.existsSync(path.join(outDir, "favicon.ico"))).toBe(true);
        expect(fs.readdirSync(path.join(pluginsDir, ".ui-build")).filter((entry) => entry.startsWith(".tmp-"))).toEqual([]);
    }, 120_000);

    it("builds plugin pages that import the web client through its package exports from the web client's sources", async () => {
        // The compiled dist/apps mirror names the search index worker by its .ts source, so building through it fails.
        pluginsDir = path.join(process.cwd(), `tmp-ui-vite-${uuid.v4()}`);
        const packageDir = path.join(pluginsDir, "node_modules", "@rapidmx-test", "web-client-importer");
        const manifest = { apiVersion: 1, ui: { apps: [{ id: "shell", host: "www", mount: "/settings/shell", dir: "apps/shell" }] } };
        write(path.join(packageDir, "package.json"), JSON.stringify({ name: "@rapidmx-test/web-client-importer", version: "1.0.0", rapidmx: { plugin: manifest } }));
        write(path.join(packageDir, "apps", "shell", "_layout.tsx"), 'export default function Layout({ children }: any) { return <html><body>{children}</body></html>; }\n');
        write(
            path.join(packageDir, "apps", "shell", "index.tsx"),
            [
                'import { initLocalIndex } from "@rapidmx/web-client/shared/search/localIndexRpcClient.js";',
                "export default function Shell() { return <p className=\"text-[#246813]\">{typeof initLocalIndex}</p>; }",
                "",
            ].join("\n"),
        );
        const plugin: InstalledPlugin = { name: "@rapidmx-test/web-client-importer", version: "1.0.0", manifest: manifest as any, entryUrl: "", packageDir, uiApps: resolvePluginUiApps(packageDir, manifest as any) };

        const result = await new PluginUiBuilder({ pluginsDir, appRoot: process.cwd(), logger }).build([plugin]);
        expect(result.failed).toEqual([]);
        expect(result.built).toEqual([plugin.name]);
        const outDir = path.dirname(path.dirname(result.manifestPath!));
        expect(fs.readdirSync(path.join(outDir, "assets")).some((file) => /^localIndexWorker-.*\.js$/.test(file))).toBe(true);
        expect(fs.readFileSync(result.manifestPath!, "utf8")).not.toContain("web-client/dist/apps");
    }, 120_000);
});
