///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { execFile } from "child_process";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";
import { parsePluginManifest, type PluginManifest, type PluginNamespace, type PluginUiApp } from "@rapidmx/restapi";

/** The packages a plugin must share with the server rather than bring its own copy of: a second copy of any of
 * them breaks decorator metadata and `instanceof` checks, so its routes, models and jobs silently never load. */
export const SHARED_PLUGIN_PEERS = ["@rapidrest/core", "@rapidrest/service-core", "@rapidmx/restapi"];

/** One plugin the server should run. */
export interface DesiredPlugin {
    name: string;
    packageVersion: string;
    /** The registry's integrity hash recorded when the plugin was added; checked against what npm installed. */
    integrity?: string;
}

/** One of a plugin's UI apps (its manifest's `ui.apps`), with the directories it's built and rendered from. */
export interface PluginUiAppFiles extends PluginUiApp {
    /** The app's TSX sources, `<package>/<dir>`: what Vite builds the client bundles from. */
    sourceDir: string;
    /** The app's compiled pages, `<package>/dist/<dir>`: what the server renders in production. */
    ssrDir: string;
}

/** A plugin that installed cleanly and is ready to import. */
export interface InstalledPlugin {
    name: string;
    version: string;
    manifest: PluginManifest;
    /** The file URL of the plugin's entry point for the server's datastore. */
    entryUrl: string;
    /** The plugin's package directory (absolute, below the plugin directory's `node_modules`). */
    packageDir?: string;
    /** The integrity hash recorded when the plugin was added, when it has one. */
    integrity?: string;
    /** The plugin's UI apps, empty when its manifest declares none. */
    uiApps?: PluginUiAppFiles[];
}

/** A plugin's UI apps, with `sourceDir` (`<packageDir>/<dir>`) and `ssrDir` (`<packageDir>/dist/<dir>`) resolved. */
export function resolvePluginUiApps(packageDir: string, manifest: PluginManifest): PluginUiAppFiles[] {
    return (manifest.ui?.apps ?? []).map((app) => ({
        ...app,
        sourceDir: path.join(packageDir, ...app.dir.split("/")),
        ssrDir: path.join(packageDir, "dist", ...app.dir.split("/")),
    }));
}

export interface PluginInstallResult {
    installed: InstalledPlugin[];
    errors: { name: string; message: string }[];
    /** When npm itself failed (for example the registry was unreachable): how many installs in a row have failed.
     * Worth retrying, unlike a plugin that installed but failed its checks. Plugins already installed by an earlier
     * install that still match what's wanted are loaded anyway. */
    installFailures?: number;
    /** Set with `installFailures` when npm's error won't go away by retrying (a missing package or version, refused
     * credentials, a corrupt package). */
    installFailurePermanent?: boolean;
}

/** npm error codes that retrying the same install won't fix. */
const PERMANENT_NPM_ERRORS = /\b(E404|E401|E403|ETARGET|EINTEGRITY|EBADENGINE|ENOVERSIONS)\b/;

/** How long an npm install may take before it's stopped, when not configured. */
export const DEFAULT_NPM_TIMEOUT_MS = 10 * 60_000;

/**
 * How much of npm's own stderr/stdout (`execFile`'s `maxBuffer` allows up to 16MB) is kept in the `Error` this module
 * raises on a failed install. Without a cap, that full, untruncated text becomes `PluginInstallResult.errors[].message`
 * for every plugin the failure affects, and `PluginHost` folds those straight into the status it reports to
 * `PluginWatcher`, which `JSON.stringify`s the whole thing into the shared `plugins:status` Redis key on every
 * heartbeat (`system:plugins:watch:interval_ms`, default 30s) for as long as the failure persists - an unbounded,
 * repeatedly-written blob relative to how verbose npm's own error output happened to be and how long the failure
 * lasts. A few KB is plenty to show an administrator what went wrong (npm's own error summary is normally much
 * shorter than this) without that risk.
 */
export const NPM_ERROR_MESSAGE_MAX_CHARS = 4000;

/** `text`, cut to `NPM_ERROR_MESSAGE_MAX_CHARS` with a note of how much was left out - see that constant's own doc
 * comment for why. Exported only so the cap itself is directly unit-testable without a real npm process producing
 * many KB of output on demand; `runNpm()` is where it's actually applied. */
export function truncateNpmOutput(text: string): string {
    if (text.length <= NPM_ERROR_MESSAGE_MAX_CHARS) {
        return text;
    }
    return `${text.slice(0, NPM_ERROR_MESSAGE_MAX_CHARS)}… (truncated, ${text.length - NPM_ERROR_MESSAGE_MAX_CHARS} more characters omitted)`;
}

/**
 * Default ceiling, in bytes, on the total size of `<plugins dir>/node_modules` right after a successful install
 * (`system:plugins:max_install_bytes`) - 500MB, generous for any real plugin's dependency tree, but bounds what a
 * malicious or compromised registry package could pull onto disk before anything ever runs it. `--ignore-scripts`
 * already stops an install script from running, so this is defense in depth against disk exhaustion, not code
 * execution. The size is only known once npm has already fetched everything - this can't prevent the download
 * itself, only refuse to keep and load the result, the same way an install that fails outright is refused: the whole
 * batch's `node_modules` is removed and every plugin in it reports the same error, an already-installed plugin that
 * still matches what's wanted keeps loading (see the `npmFailure` handling this reuses), and it counts toward
 * `installFailures` like any other install failure - except it is always `installFailurePermanent`, since a package
 * that's too big now will still be too big on the next retry.
 */
export const DEFAULT_MAX_INSTALL_BYTES = 500 * 1024 * 1024;

/** `bytes`, as a short human-readable size for an error message. */
function formatBytes(bytes: number): string {
    return bytes >= 1024 * 1024 * 1024 ? `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB` : `${Math.round(bytes / (1024 * 1024))}MB`;
}

/**
 * Total size, in bytes, of every regular file at or below `dir`, never following a link (only what was actually
 * written under `dir` counts). Async, walking with `fs.promises` rather than `*Sync`, so summing a huge or
 * deliberately bloated tree doesn't block the event loop of a process also serving live HTTP/mail traffic - the same
 * rationale as `PluginPurgeFiles.ts`'s `removeContainedAsync()`. A missing or unreadable entry is skipped rather than
 * failing the whole walk: this backs a best-effort ceiling, not a value that must be exact.
 */
async function directorySizeBytes(dir: string): Promise<number> {
    let entries: import("fs").Dirent[];
    try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
        return 0;
    }
    let total: number = 0;
    for (const entry of entries) {
        const full: string = path.join(dir, entry.name);
        if (entry.isSymbolicLink()) {
            continue;
        } else if (entry.isDirectory()) {
            total += await directorySizeBytes(full);
        } else if (entry.isFile()) {
            try {
                total += (await fs.promises.stat(full)).size;
            } catch {
                // Removed mid-walk, or otherwise unreadable - not counted.
            }
        }
    }
    return total;
}

/** What the last install was run with, recorded in `.install-stamp`. */
interface InstallStamp {
    /** Hash of the plugin directory's `package.json`. */
    plugins: string;
    /** Hash of the registries packages come from. */
    registries: string;
    /** Whether that install finished. */
    complete: boolean;
}

const sha256 = (value: unknown): string => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** The lockfile path of dependency `name` as Node resolves it from the package at lockfile path `from`. */
function resolveLockDependency(packages: Record<string, any>, from: string, name: string): string | undefined {
    let base: string = from;
    for (;;) {
        const candidate: string = `${base}/node_modules/${name}`;
        if (packages[candidate]) {
            return candidate;
        }
        const parent: number = base.lastIndexOf("/node_modules/");
        if (parent < 0) {
            break;
        }
        base = base.slice(0, parent);
    }
    return packages[`node_modules/${name}`] ? `node_modules/${name}` : undefined;
}

/** The package name at lockfile path `key` (`node_modules/a/node_modules/@scope/b` -> `@scope/b`). */
function lockPackageName(key: string): string {
    return key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length);
}

export interface PluginInstallerOptions {
    /** Where plugins are installed. Must sit below the server's own directory, so a plugin's imports of the shared
     * peers resolve upward to the server's copies. */
    dir: string;
    /** The server's own directory (the one holding its `node_modules`). */
    appRoot: string;
    registry: string;
    registryToken?: string;
    /** Plugin namespaces; any with their own registry are installed from it (an `.npmrc` `@scope:registry=` line). */
    namespaces?: PluginNamespace[];
    /** Package name to local `.tgz` path, installed instead of the registry version (development and tests). */
    sources?: Record<string, string>;
    /** Which entry point to load: `mongo` or `sql`. */
    datastore: string;
    logger?: any;
    /** How long npm may run before it's stopped and the install counts as failed. */
    npmTimeoutMs?: number;
    /** Ceiling, in bytes, on the total size of the installed `node_modules` - see `DEFAULT_MAX_INSTALL_BYTES`'s own
     * doc comment. `0` (not `undefined`) disables the check. */
    maxInstallBytes?: number;
    /** Whether a registry plugin must have an integrity hash recorded when it was added (default `true`). With `false`,
     * a plugin from a registry that doesn't publish integrity hashes loads without its package being verified. */
    requireIntegrity?: boolean;
    /** Runs npm. Replaceable so tests needn't reach a registry. */
    runNpm?: (args: string[], cwd: string, timeoutMs: number, signal?: AbortSignal) => Promise<void>;
}

/**
 * Runs `npm` in `cwd`, rejecting with its output when it fails, takes longer than `timeoutMs`, or `signal` aborts.
 *
 * `signal` lets a caller with its own, shorter outer timeout (e.g. `InstallingPurgeHookRunner`'s purge-hook timeout,
 * typically well under `timeoutMs`) actually kill this child process when that outer timeout fires, rather than
 * leaving it running in the background for up to `timeoutMs` while the caller has already given up and moved on -
 * `execFile`'s own `signal` option kills the process the same way `AbortController.abort()` would.
 */
export function runNpm(args: string[], cwd: string, timeoutMs: number = DEFAULT_NPM_TIMEOUT_MS, signal?: AbortSignal): Promise<void> {
    const windows: boolean = process.platform === "win32";
    return new Promise((resolve, reject) => {
        execFile(windows ? "npm.cmd" : "npm", args, { cwd, shell: windows, maxBuffer: 16 * 1024 * 1024, timeout: timeoutMs, signal }, (err, stdout, stderr) => {
            if (err) {
                if (signal?.aborted) {
                    reject(new Error(`npm ${args[0]} was stopped: the caller's own timeout expired.`));
                    return;
                }
                const timedOut: boolean = (err as any).killed && (err as any).signal !== null;
                reject(
                    new Error(
                        timedOut
                            ? `npm ${args[0]} failed: it took longer than ${Math.round(timeoutMs / 1000)}s.`
                            : `npm ${args[0]} failed: ${truncateNpmOutput(String(stderr || stdout || err.message).trim())}`,
                    ),
                );
                return;
            }
            resolve();
        });
    });
}

/** The directory of package `name` as Node resolves it from `fromDir`: the nearest `node_modules/<name>` walking
 * upward. Resolves `undefined` when no such package is reachable. */
export function findPackageDir(fromDir: string, name: string): string | undefined {
    let dir: string = path.resolve(fromDir);
    for (;;) {
        const candidate: string = path.join(dir, "node_modules", ...name.split("/"));
        if (fs.existsSync(path.join(candidate, "package.json"))) {
            return fs.realpathSync(candidate);
        }
        const parent: string = path.dirname(dir);
        if (parent === dir) {
            return undefined;
        }
        dir = parent;
    }
}

/** The file an `exports` entry points at, for the `import` condition. */
function exportTarget(pkg: any, subpath: string): string | undefined {
    const entry: any = pkg.exports?.[subpath];
    if (typeof entry === "string") {
        return entry;
    }
    return entry?.import ?? entry?.default;
}

/**
 * Installs the server's plugins with npm into one directory and checks each one before anything imports it:
 * the version and integrity npm installed, the manifest's plugin API version, and that the plugin shares the
 * server's copies of `SHARED_PLUGIN_PEERS`. A plugin that fails a check is reported and skipped; the others
 * still load.
 *
 * npm runs with `--ignore-scripts` (a plugin's install scripts never run) and without installing peer
 * dependencies, which resolve to the server's own copies instead.
 */
export class PluginInstaller {
    private readonly runNpm: (args: string[], cwd: string, timeoutMs: number, signal?: AbortSignal) => Promise<void>;

    constructor(private readonly options: PluginInstallerOptions) {
        this.runNpm = options.runNpm ?? runNpm;
    }

    /** @param signal Aborts the underlying npm child process (see `runNpm()`'s own doc comment) - optional, since most
     * callers rely on `timeoutMs`/`npmTimeoutMs` alone. */
    public async install(desired: DesiredPlugin[], signal?: AbortSignal): Promise<PluginInstallResult> {
        const { dir } = this.options;
        fs.mkdirSync(dir, { recursive: true });
        const errors: { name: string; message: string }[] = [];
        // Tokens can change or be removed without anything else changing, so this is rewritten on every start.
        this.writeNpmrc();

        // Without the integrity hash recorded when a registry plugin was added, nothing proves the registry still serves
        // the same package. (A local `sources` tarball has none, and isn't checked.)
        const plugins: DesiredPlugin[] = [];
        for (const plugin of desired) {
            if (this.options.requireIntegrity !== false && !this.options.sources?.[plugin.name] && !plugin.integrity) {
                errors.push({
                    name: plugin.name,
                    message: "No integrity hash was recorded when the plugin was added, so the installed package can't be verified. Update or re-add the plugin.",
                });
            } else {
                plugins.push(plugin);
            }
        }

        const dependencies: Record<string, string> = {};
        for (const plugin of plugins) {
            const source: string | undefined = this.options.sources?.[plugin.name];
            dependencies[plugin.name] = source ? `file:${path.resolve(source)}` : plugin.packageVersion;
        }
        const manifest = { name: "rapidmx-plugins", private: true, dependencies };
        const stamp: InstallStamp = { plugins: sha256(manifest), registries: sha256([this.options.registry, this.scopedRegistries()]), complete: false };
        const stampFile: string = path.join(dir, ".install-stamp");
        const failuresFile: string = path.join(dir, ".install-failures");
        const previous: InstallStamp | undefined = this.readJson(stampFile);

        const upToDate: boolean =
            !!previous?.complete &&
            previous.plugins === stamp.plugins &&
            previous.registries === stamp.registries &&
            fs.existsSync(path.join(dir, "node_modules"));
        let npmFailure: Pick<PluginInstallResult, "installFailures" | "installFailurePermanent"> & { message: string } | undefined;
        if (!upToDate) {
            fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(manifest, null, 2));
            // The lockfile keeps the plugins' own dependencies pinned from one install to the next; npm updates it for the
            // plugins that changed. Its entries record the registry each package came from, so it starts over when the
            // registries change.
            if (previous?.registries !== stamp.registries) {
                fs.rmSync(path.join(dir, "package-lock.json"), { force: true });
            }
            fs.writeFileSync(stampFile, JSON.stringify(stamp));
            if (plugins.length === 0) {
                fs.rmSync(path.join(dir, "node_modules"), { recursive: true, force: true });
            } else {
                try {
                    await this.runNpm(
                        [
                            "install",
                            "--omit=dev",
                            "--omit=peer",
                            "--legacy-peer-deps",
                            "--ignore-scripts",
                            "--no-audit",
                            "--no-fund",
                            "--registry",
                            this.options.registry,
                        ],
                        dir,
                        this.options.npmTimeoutMs ?? DEFAULT_NPM_TIMEOUT_MS,
                        signal,
                    );
                } catch (err: any) {
                    // One unavailable package fails the whole install. Plugins an earlier install left in place still load
                    // below if they pass every check against what's wanted now; the rest report npm's error.
                    const installFailures: number = (Number(this.readJson(failuresFile)) || 0) + 1;
                    fs.writeFileSync(failuresFile, String(installFailures));
                    npmFailure = { message: err.message, installFailures, installFailurePermanent: PERMANENT_NPM_ERRORS.test(String(err.message)) };
                }
                if (!npmFailure) {
                    const maxInstallBytes: number = this.options.maxInstallBytes ?? DEFAULT_MAX_INSTALL_BYTES;
                    const installedBytes: number = maxInstallBytes > 0 ? await directorySizeBytes(path.join(dir, "node_modules")) : 0;
                    if (maxInstallBytes > 0 && installedBytes > maxInstallBytes) {
                        const installFailures: number = (Number(this.readJson(failuresFile)) || 0) + 1;
                        fs.writeFileSync(failuresFile, String(installFailures));
                        npmFailure = {
                            message: `The installed plugins total ${formatBytes(installedBytes)}, over the ${formatBytes(maxInstallBytes)} limit (system:plugins:max_install_bytes) - refusing to load any of them.`,
                            installFailures,
                            installFailurePermanent: true,
                        };
                        this.options.logger?.error?.(npmFailure.message);
                        fs.rmSync(path.join(dir, "node_modules"), { recursive: true, force: true });
                    }
                }
            }
            if (!npmFailure) {
                fs.writeFileSync(stampFile, JSON.stringify({ ...stamp, complete: true }));
                fs.rmSync(failuresFile, { force: true });
            }
        }

        const lock: any = this.readJson(path.join(dir, "package-lock.json")) ?? {};
        const bundledPeers: Map<string, string> = this.findBundledPeers(plugins, lock);
        const installed: InstalledPlugin[] = [];
        for (const plugin of plugins) {
            try {
                installed.push(this.check(plugin, lock, bundledPeers.get(plugin.name)));
            } catch (err: any) {
                errors.push({ name: plugin.name, message: npmFailure ? npmFailure.message : err.message });
            }
        }
        if (npmFailure) {
            return { installed, errors, installFailures: npmFailure.installFailures, installFailurePermanent: npmFailure.installFailurePermanent };
        }
        return { installed, errors };
    }

    /**
     * Finds the plugins whose installed dependencies include a copy of one of `SHARED_PLUGIN_PEERS`, from the lockfile:
     * returns each such plugin's first copy (its lockfile path). npm may hoist such a copy to the top of the plugin
     * directory, where every plugin's import of that package would find it before the server's copy - so a hoisted copy
     * is deleted once it's attributed to the plugins that brought it, which aren't loaded, and the rest still load.
     */
    private findBundledPeers(plugins: DesiredPlugin[], lock: any): Map<string, string> {
        const packages: Record<string, any> = lock.packages ?? {};
        const result: Map<string, string> = new Map();
        const hoisted: Set<string> = new Set();
        for (const plugin of plugins) {
            const root: string = `node_modules/${plugin.name}`;
            const reached: Set<string> = new Set([root]);
            const queue: string[] = [root];
            while (queue.length > 0) {
                const from: string = queue.shift()!;
                const entry: any = packages[from];
                for (const dependency of Object.keys({ ...entry?.dependencies, ...entry?.optionalDependencies })) {
                    const found: string | undefined = resolveLockDependency(packages, from, dependency);
                    if (found && !reached.has(found)) {
                        reached.add(found);
                        queue.push(found);
                    }
                }
            }
            const copies: string[] = [...reached].filter(
                (key) => key !== root && SHARED_PLUGIN_PEERS.includes(lockPackageName(key)) && !packages[key]?.peer && !packages[key]?.dev,
            );
            if (copies.length > 0) {
                result.set(plugin.name, copies[0]);
                copies.filter((key) => key.split("node_modules/").length === 2).forEach((key) => hoisted.add(key));
            }
        }
        for (const key of hoisted) {
            this.options.logger?.warn?.(`Removing ${key} from the plugin directory: it would replace the server's copy for every plugin.`);
            fs.rmSync(path.join(this.options.dir, ...key.split("/")), { recursive: true, force: true });
        }
        return result;
    }

    /** Namespaces installed from their own registry, as `[scope, registry]` pairs. */
    private scopedRegistries(): [string, string][] {
        return (this.options.namespaces ?? []).filter((ns) => ns.registry).map((ns) => [ns.name, ns.registry!]);
    }

    /** The `.npmrc` line holding `token` for `registry`. */
    private static authLine(registry: string, token: string): string {
        return `${registry.replace(/^https?:/, "").replace(/\/?$/, "/")}:_authToken=${token}`;
    }

    private writeNpmrc(): void {
        const npmrc: string = path.join(this.options.dir, ".npmrc");
        const lines: string[] = [];
        if (this.options.registryToken) {
            lines.push(PluginInstaller.authLine(this.options.registry, this.options.registryToken));
        }
        for (const namespace of this.options.namespaces ?? []) {
            if (namespace.registry) {
                lines.push(`${namespace.name}:registry=${namespace.registry}`);
                if (namespace.token) {
                    lines.push(PluginInstaller.authLine(namespace.registry, namespace.token));
                }
            }
        }
        if (lines.length === 0) {
            fs.rmSync(npmrc, { force: true });
            return;
        }
        fs.writeFileSync(npmrc, `${lines.join("\n")}\n`, { mode: 0o600 });
        // `mode` only applies when the file is created.
        fs.chmodSync(npmrc, 0o600);
    }

    /** The parsed JSON in `file`, or `undefined` when it's missing or unreadable. */
    private readJson(file: string): any {
        try {
            return JSON.parse(fs.readFileSync(file, "utf8"));
        } catch {
            return undefined;
        }
    }

    private check(plugin: DesiredPlugin, lock: any, bundledPeer?: string): InstalledPlugin {
        const packageDir: string = path.join(this.options.dir, "node_modules", ...plugin.name.split("/"));
        const packageJson: string = path.join(packageDir, "package.json");
        if (!fs.existsSync(packageJson)) {
            throw new Error("The package was not installed.");
        }
        const pkg: any = JSON.parse(fs.readFileSync(packageJson, "utf8"));
        const sourced: boolean = !!this.options.sources?.[plugin.name];

        if (!sourced) {
            if (pkg.version !== plugin.packageVersion) {
                throw new Error(`Expected version ${plugin.packageVersion}, but ${pkg.version} was installed.`);
            }
            const installedIntegrity: string | undefined = lock.packages?.[`node_modules/${plugin.name}`]?.integrity;
            // Without a recorded hash (only let through when `requireIntegrity` is off) there's nothing to compare.
            if ((plugin.integrity || this.options.requireIntegrity !== false) && installedIntegrity !== plugin.integrity) {
                throw new Error("The installed package's integrity hash doesn't match the one recorded when it was added.");
            }
        }

        const manifest: PluginManifest | string = parsePluginManifest(pkg);
        if (typeof manifest === "string") {
            throw new Error(manifest);
        }

        if (bundledPeer) {
            throw new Error(`The plugin brings its own copy of ${lockPackageName(bundledPeer)} (${bundledPeer}) instead of using the server's, so it can't be loaded.`);
        }
        for (const peer of SHARED_PLUGIN_PEERS) {
            const fromPlugin: string | undefined = findPackageDir(packageDir, peer);
            const fromServer: string | undefined = findPackageDir(this.options.appRoot, peer);
            if (fromPlugin !== fromServer) {
                throw new Error(`The plugin resolves its own copy of ${peer} instead of the server's, so it can't be loaded.`);
            }
        }

        const target: string | undefined = exportTarget(pkg, `./${this.options.datastore}`);
        if (!target) {
            throw new Error(`The plugin has no ./${this.options.datastore} entry point.`);
        }
        const entry: string = path.resolve(fs.realpathSync(packageDir), target);
        if (!fs.existsSync(entry)) {
            throw new Error(`The plugin's ./${this.options.datastore} entry point (${target}) is missing.`);
        }
        return {
            name: plugin.name,
            version: pkg.version,
            manifest,
            entryUrl: pathToFileURL(entry).href,
            packageDir,
            ...(plugin.integrity ? { integrity: plugin.integrity } : {}),
            uiApps: resolvePluginUiApps(packageDir, manifest),
        };
    }
}
