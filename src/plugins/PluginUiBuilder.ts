///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { CORE_APP_DIRS, createServerViteConfig, WEB_CLIENT_APP_CSS, type ServerViteConfigOptions } from "../lib/serverViteConfig.js";
import { precompressDirectory } from "../lib/staticAssets.js";
import { hasTsxContext } from "../routes/webClientAppDir.js";
import type { InstalledPlugin } from "./PluginInstaller.js";

/** The directory under the plugin directory that holds UI builds, one folder per `uiHash`. */
export const UI_BUILD_DIR = ".ui-build";

/** Bumped when the build's inputs or layout change in a way the hashed versions don't capture. */
const BUILD_FORMAT = 1;

/** Installed packages whose versions (and yarn patches) decide what a UI build contains. */
const HASHED_PACKAGES = [
    "@rapidmx/web-client",
    "@rapidmx/react-shared",
    "@rapidrest/react",
    "react",
    "react-dom",
    "vite",
    "@vitejs/plugin-react",
    "@tailwindcss/vite",
    "tailwindcss",
];

/** A temporary build folder older than this is left over from a start that died mid-build. */
const STALE_TEMP_MS = 60 * 60_000;

/** The longest build error kept for a plugin's status. */
const MAX_ERROR_LENGTH = 2000;

const HASH_NAME = /^[0-9a-f]{64}$/;
const FAILURE_RECORD = /^failed-([0-9a-f]{64})\.json$/;

export interface PluginUiBuildResult {
    /** The build's Vite manifest, or `undefined` to keep the image's prebuilt build (no plugin UI, or none built). */
    manifestPath?: string;
    /** The `uiHash` of the build in use. */
    hash?: string;
    /** The plugins whose UI apps are in the build. */
    built: string[];
    /** The plugins whose UI apps couldn't be built, and why. */
    failed: { name: string; message: string }[];
}

export interface PluginUiBuilderOptions {
    /** The plugin directory; builds go in its `.ui-build` folder. */
    pluginsDir: string;
    /** The server's directory, which must be the working directory: Vite's root, and the base of the app directories. */
    appRoot: string;
    logger?: any;
    /** The image's prebuilt build. Its static files are copied into a build when the server has no `public` folder. */
    prebuiltOutDir?: string;
    /** Test seams. */
    coreAppDirs?: readonly string[];
    createConfig?: (options: ServerViteConfigOptions) => Promise<any>;
    build?: (config: any) => Promise<unknown>;
}

/** `value` with backslashes as forward slashes, lowercased: for comparing paths in error text. */
function normalizedPath(value: string): string {
    return value.replace(/\\/g, "/").toLowerCase();
}

/** Everything an error from Vite or Rolldown says about where it happened. */
function errorText(err: any): string {
    const parts: unknown[] = [err?.message, err?.stack, err?.id, err?.loc?.file, err?.plugin];
    for (const inner of Array.isArray(err?.errors) ? err.errors : []) {
        parts.push(inner?.message, inner?.stack, inner?.id, inner?.loc?.file);
    }
    return parts.filter((part) => typeof part === "string").join("\n");
}

/**
 * Builds enabled plugins' UI apps into the server's browser bundles at startup.
 *
 * Plugins ship their pages as TSX sources, so the client bundles are built on the server, together with the core apps:
 * one dependency graph, one React, one react-shared and one Tailwind stylesheet. A build is kept in
 * `<plugins dir>/.ui-build/<uiHash>` and reused while the hash is unchanged. The hash covers the web client, react-shared
 * and build tooling versions (and their yarn patches) and each UI plugin's name, version and integrity (or the content of
 * its apps when it has no integrity hash, like a local tarball).
 *
 * With no plugin UI, nothing is built and the image's prebuilt bundles stay in use.
 *
 * A build is written to a temporary folder and renamed into place once complete, so an interrupted build is never used
 * and concurrent starts can't corrupt one: a start that finds the folder already completed by another uses it.
 *
 * A failed build is retried without the plugins it names. When the failure can't be attributed to a plugin, all plugin
 * UI is left out and the prebuilt bundles stay in use. Plugins that failed are remembered for their plugin set, so the
 * next start doesn't repeat the failing build. Nothing here stops the server from starting.
 */
export class PluginUiBuilder {
    private readonly buildRoot: string;
    private patchHashes?: Map<string, string>;

    constructor(private readonly options: PluginUiBuilderOptions) {
        this.buildRoot = path.join(options.pluginsDir, UI_BUILD_DIR);
    }

    /** The plugins among `plugins` with at least one UI app. */
    public static uiPlugins(plugins: InstalledPlugin[]): InstalledPlugin[] {
        return plugins.filter((plugin) => (plugin.uiApps?.length ?? 0) > 0);
    }

    public async build(plugins: InstalledPlugin[]): Promise<PluginUiBuildResult> {
        const { logger } = this.options;
        const failed: PluginUiBuildResult["failed"] = [];
        let candidates: InstalledPlugin[] = PluginUiBuilder.uiPlugins(plugins);
        if (candidates.length === 0) {
            // Earlier builds stay, so re-enabling the same plugins serves their build straight away; the next build
            // removes them.
            this.prune(undefined, undefined, true);
            return { built: [], failed };
        }

        const missingCore: string[] = (this.options.coreAppDirs ?? CORE_APP_DIRS).filter((dir) => !fs.existsSync(path.resolve(this.options.appRoot, dir)));
        if (missingCore.length > 0) {
            const message: string = `The plugin's UI wasn't built: the server's own app sources are missing (${missingCore.join(", ")}).`;
            logger?.error?.(message);
            return { built: [], failed: candidates.map((plugin) => ({ name: plugin.name, message })) };
        }

        candidates = candidates.filter((plugin) => {
            const problem: string | undefined = this.missingFiles(plugin);
            if (problem) {
                failed.push({ name: plugin.name, message: problem });
                logger?.error?.(`Plugin ${plugin.name}'s UI was not built: ${problem}`);
            }
            return !problem;
        });

        // Plugins an earlier start found breaking the build of this same plugin set are left out straight away.
        const setHash: string = this.computeHash(candidates);
        const remembered: PluginUiBuildResult["failed"] = this.readFailureRecord(setHash);
        for (const failure of remembered) {
            if (candidates.some((plugin) => plugin.name === failure.name)) {
                failed.push(failure);
                logger?.error?.(`Plugin ${failure.name}'s UI was not built (it failed an earlier build of the same plugins): ${failure.message}`);
            }
        }
        candidates = candidates.filter((plugin) => !remembered.some((failure) => failure.name === plugin.name));
        const attributed: PluginUiBuildResult["failed"] = [...remembered];

        while (candidates.length > 0) {
            const hash: string = this.computeHash(candidates);
            const manifestPath: string = path.join(this.buildRoot, hash, ".vite", "manifest.json");
            if (!fs.existsSync(manifestPath)) {
                try {
                    await this.runBuild(candidates, hash);
                } catch (err: any) {
                    const text: string = normalizedPath(errorText(err));
                    const culprits: InstalledPlugin[] = candidates.filter((plugin) => this.mentions(text, plugin));
                    const message: string = `The plugin's UI failed to build: ${String(err?.message ?? err).slice(0, MAX_ERROR_LENGTH)}`;
                    if (culprits.length === 0) {
                        logger?.error?.(`Plugin UI failed to build, so no plugin UI is served: ${err?.stack ?? err?.message ?? err}`);
                        failed.push(...candidates.map((plugin) => ({ name: plugin.name, message })));
                        return { built: [], failed };
                    }
                    for (const plugin of culprits) {
                        logger?.error?.(`Plugin ${plugin.name}'s UI failed to build, so it's left out: ${err?.message ?? err}`);
                        failed.push({ name: plugin.name, message });
                        attributed.push({ name: plugin.name, message });
                    }
                    this.writeFailureRecord(setHash, attributed);
                    candidates = candidates.filter((plugin) => !culprits.includes(plugin));
                    continue;
                }
            } else {
                logger?.info?.(`Using the plugin UI build ${hash}.`);
            }
            this.prune(hash, setHash);
            return { manifestPath, hash, built: candidates.map((plugin) => plugin.name), failed };
        }
        this.prune(undefined, setHash);
        return { built: [], failed };
    }

    /**
     * The `uiHash` of a build containing `plugins`' UI apps: the build format, the server's version, the hashed packages'
     * installed versions and patches, and each plugin's name, version, apps and integrity (or apps' content).
     */
    public computeHash(plugins: InstalledPlugin[]): string {
        const packages = HASHED_PACKAGES.map((name) => ({ name, version: this.installedVersion(name), patch: this.patchHash(name) }));
        const entries = [...plugins]
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((plugin) => ({
                name: plugin.name,
                version: plugin.version,
                apps: (plugin.uiApps ?? []).map(({ id, host, mount, dir }) => ({ id, host, mount, dir })),
                integrity: plugin.integrity ?? `content:${this.contentHash((plugin.uiApps ?? []).map((app) => app.sourceDir))}`,
            }));
        const server = { version: this.installedVersion(".") };
        return crypto.createHash("sha256").update(JSON.stringify({ format: BUILD_FORMAT, server, packages, plugins: entries })).digest("hex");
    }

    /** Why `plugin`'s apps can't be built or served, when a directory they need is missing. */
    private missingFiles(plugin: InstalledPlugin): string | undefined {
        for (const app of plugin.uiApps ?? []) {
            if (!fs.existsSync(app.sourceDir)) {
                return `Its UI app ${app.id} has no sources at ${app.dir}.`;
            }
            // Compiled pages are only rendered outside tsx and test runners.
            if (!hasTsxContext() && !fs.existsSync(app.ssrDir)) {
                return `Its UI app ${app.id} has no compiled pages at dist/${app.dir}.`;
            }
        }
        return undefined;
    }

    /** Whether error text (normalized with `normalizedPath`) names a file in `plugin`'s package. */
    private mentions(text: string, plugin: InstalledPlugin): boolean {
        const needles: string[] = [`/node_modules/${plugin.name.toLowerCase()}/`];
        if (plugin.packageDir) {
            needles.push(`${normalizedPath(plugin.packageDir)}/`, `${normalizedPath(path.relative(this.options.appRoot, plugin.packageDir))}/`);
        }
        return needles.some((needle) => text.includes(needle));
    }

    /** Runs the Vite build for `plugins` into a temporary folder and moves it to `<build root>/<hash>`. */
    private async runBuild(plugins: InstalledPlugin[], hash: string): Promise<void> {
        const { appRoot, logger } = this.options;
        fs.mkdirSync(this.buildRoot, { recursive: true });
        const temp: string = path.join(this.buildRoot, `.tmp-${hash.slice(0, 12)}-${process.pid}-${crypto.randomBytes(4).toString("hex")}`);
        // The generated stylesheet sits next to the build rather than in it (Vite empties the output folder first).
        const cssDir: string = `${temp}-css`;
        const cssFile: string = path.join(cssDir, "plugin-ui.css");
        const relative = (target: string): string => path.relative(appRoot, target).replace(/\\/g, "/");
        const fromCss = (target: string): string => path.relative(path.dirname(cssFile), target).replace(/\\/g, "/");
        const started: number = Date.now();
        logger?.info?.(`Building the UI of ${plugins.map((plugin) => `${plugin.name}@${plugin.version}`).join(", ")}. This takes a while the first time after a plugin change.`);
        try {
            // The web client's stylesheet, plus the plugins' packages as Tailwind sources so their classes are generated.
            const css: string[] = [`@import ${JSON.stringify(fromCss(path.resolve(appRoot, WEB_CLIENT_APP_CSS)))};`];
            for (const plugin of plugins) {
                css.push(`@source ${JSON.stringify(fromCss(plugin.packageDir ?? plugin.uiApps![0].sourceDir))};`);
            }
            fs.mkdirSync(cssDir, { recursive: true });
            fs.writeFileSync(cssFile, `${css.join("\n")}\n`);

            const apps = plugins.flatMap((plugin) => plugin.uiApps ?? []);
            const createConfig = this.options.createConfig ?? createServerViteConfig;
            const config: any = await createConfig({
                extraAppDirs: apps.map((app) => relative(app.sourceDir)),
                outDir: temp,
                stylesheets: apps.map((app) => ({ appDir: relative(app.sourceDir), css: cssFile })),
            });
            const publicDir: string = path.join(appRoot, "public");
            const hasPublicDir: boolean = fs.existsSync(publicDir);
            const build = this.options.build ?? (async (inline: any) => (await import("vite")).build(inline));
            await build({
                ...config,
                configFile: false,
                root: appRoot,
                logLevel: "warn",
                cacheDir: path.join(this.buildRoot, ".vite-cache"),
                publicDir: hasPublicDir ? publicDir : false,
                build: { ...config.build, outDir: temp, emptyOutDir: true },
            });
            if (!hasPublicDir) {
                this.copyPrebuiltStaticFiles(temp);
            }
            if (!fs.existsSync(path.join(temp, ".vite", "manifest.json"))) {
                throw new Error("The build finished without writing a Vite manifest.");
            }
            await this.precompress(temp);
            this.moveIntoPlace(temp, path.join(this.buildRoot, hash));
            logger?.info?.(`Built the plugin UI ${hash} in ${Math.round((Date.now() - started) / 1000)}s (process memory ${Math.round(process.memoryUsage().rss / 1048576)} MiB).`);
        } finally {
            fs.rmSync(cssDir, { recursive: true, force: true });
            fs.rmSync(temp, { recursive: true, force: true });
        }
    }

    /**
     * Writes brotli and gzip siblings for the build's compressible files, which the static file route sends with
     * `Content-Encoding` (see `lib/staticAssets.ts`). Best effort: without them the route compresses on first request.
     * Brotli 9 rather than the image build's 11 keeps the wait before the server starts short.
     */
    private async precompress(dir: string): Promise<void> {
        try {
            const result = await precompressDirectory(dir, { brotliQuality: 9 });
            this.options.logger?.info?.(`Pre-compressed ${result.compressed} files of the plugin UI build (${Math.round(result.bytesBefore / 1024)} KiB -> ${Math.round(result.bytesAfter / 1024)} KiB).`);
        } catch (err: any) {
            this.options.logger?.warn?.(`Could not pre-compress the plugin UI build, it is compressed on demand instead: ${err?.message ?? err}`);
        }
    }

    /** Renames a completed build folder to `target`, or keeps `target` when another start completed it first. */
    private moveIntoPlace(temp: string, target: string): void {
        try {
            fs.renameSync(temp, target);
        } catch (err) {
            if (!fs.existsSync(path.join(target, ".vite", "manifest.json"))) {
                throw err;
            }
        }
    }

    /** Copies the prebuilt build's static files (everything but its bundles and manifest) into `outDir`. */
    private copyPrebuiltStaticFiles(outDir: string): void {
        const prebuilt: string | undefined = this.options.prebuiltOutDir && path.resolve(this.options.appRoot, this.options.prebuiltOutDir);
        if (!prebuilt || !fs.existsSync(prebuilt)) {
            return;
        }
        for (const entry of fs.readdirSync(prebuilt)) {
            if (entry !== "assets" && entry !== ".vite") {
                fs.cpSync(path.join(prebuilt, entry), path.join(outDir, entry), { recursive: true, preserveTimestamps: true });
            }
        }
    }

    /** Removes builds other than `keep` (none with `keepBuilds`), failure records other than `keepRecord`'s, and temporary
     * folders left by dead starts. */
    private prune(keep?: string, keepRecord?: string, keepBuilds: boolean = false): void {
        let entries: string[];
        try {
            entries = fs.readdirSync(this.buildRoot);
        } catch {
            return;
        }
        for (const entry of entries) {
            const full: string = path.join(this.buildRoot, entry);
            try {
                const record: RegExpExecArray | null = FAILURE_RECORD.exec(entry);
                if ((HASH_NAME.test(entry) && entry !== keep && !keepBuilds) || (record && record[1] !== keepRecord)) {
                    fs.rmSync(full, { recursive: true, force: true });
                } else if (entry.startsWith(".tmp-") && Date.now() - fs.statSync(full).mtimeMs > STALE_TEMP_MS) {
                    fs.rmSync(full, { recursive: true, force: true });
                }
            } catch (err: any) {
                this.options.logger?.warn?.(`Could not remove the old plugin UI build ${full}: ${err.message}`);
            }
        }
    }

    private readFailureRecord(setHash: string): PluginUiBuildResult["failed"] {
        try {
            const record: any = JSON.parse(fs.readFileSync(path.join(this.buildRoot, `failed-${setHash}.json`), "utf8"));
            return Array.isArray(record?.failed) ? record.failed.filter((entry: any) => typeof entry?.name === "string" && typeof entry?.message === "string") : [];
        } catch {
            return [];
        }
    }

    private writeFailureRecord(setHash: string, failed: PluginUiBuildResult["failed"]): void {
        try {
            fs.mkdirSync(this.buildRoot, { recursive: true });
            fs.writeFileSync(path.join(this.buildRoot, `failed-${setHash}.json`), JSON.stringify({ failed }));
        } catch (err: any) {
            this.options.logger?.warn?.(`Could not record the plugin UI build failure: ${err.message}`);
        }
    }

    /** The installed version of package `name` (`.` for the server itself), or `null` when it isn't installed. */
    private installedVersion(name: string): string | null {
        const dir: string = name === "." ? this.options.appRoot : path.join(this.options.appRoot, "node_modules", ...name.split("/"));
        try {
            return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).version ?? null;
        } catch {
            return null;
        }
    }

    /** The yarn patch hash of package `name` from the server's `yarn.lock`, or `null` when it isn't patched. */
    private patchHash(name: string): string | null {
        if (!this.patchHashes) {
            this.patchHashes = new Map();
            let lock: string = "";
            try {
                lock = fs.readFileSync(path.join(this.options.appRoot, "yarn.lock"), "utf8");
            } catch {
                // No lockfile (a plain npm install): versions alone.
            }
            for (const match of lock.matchAll(/resolution: "((?:@[^/"]+\/)?[^@"]+)@patch:[^"]*[?&]hash=([0-9a-z]+)"/g)) {
                this.patchHashes.set(match[1], match[2]);
            }
        }
        return this.patchHashes.get(name) ?? null;
    }

    /** A hash of every file under `dirs` (paths and contents), skipping `node_modules`. */
    private contentHash(dirs: string[]): string {
        const hash: crypto.Hash = crypto.createHash("sha256");
        const walk = (root: string, dir: string): void => {
            let entries: fs.Dirent[];
            try {
                entries = fs.readdirSync(dir, { withFileTypes: true });
            } catch {
                return;
            }
            for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
                const full: string = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    if (entry.name !== "node_modules") {
                        walk(root, full);
                    }
                } else if (entry.isFile()) {
                    hash.update(path.relative(root, full).replace(/\\/g, "/"));
                    hash.update("\0");
                    hash.update(fs.readFileSync(full));
                    hash.update("\0");
                }
            }
        };
        for (const dir of dirs) {
            hash.update("");
            walk(dir, dir);
        }
        return hash.digest("hex");
    }
}
