///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { execFile } from "child_process";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";
import { parsePluginManifest, type PluginManifest, type PluginNamespace } from "@rapidmx/restapi";

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

/** A plugin that installed cleanly and is ready to import. */
export interface InstalledPlugin {
    name: string;
    version: string;
    manifest: PluginManifest;
    /** The file URL of the plugin's entry point for the server's datastore. */
    entryUrl: string;
}

export interface PluginInstallResult {
    installed: InstalledPlugin[];
    errors: { name: string; message: string }[];
    /** When npm itself failed (for example the registry was unreachable): how many installs in a row have failed.
     * Worth retrying, unlike a plugin that installed but failed its checks. */
    installFailures?: number;
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
    /** Runs npm. Replaceable so tests needn't reach a registry. */
    runNpm?: (args: string[], cwd: string) => Promise<void>;
}

/** Runs `npm` in `cwd`, rejecting with its output when it fails. */
export function runNpm(args: string[], cwd: string): Promise<void> {
    const windows: boolean = process.platform === "win32";
    return new Promise((resolve, reject) => {
        execFile(windows ? "npm.cmd" : "npm", args, { cwd, shell: windows, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) {
                reject(new Error(`npm ${args[0]} failed: ${String(stderr || stdout || err.message).trim()}`));
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
    private readonly runNpm: (args: string[], cwd: string) => Promise<void>;

    constructor(private readonly options: PluginInstallerOptions) {
        this.runNpm = options.runNpm ?? runNpm;
    }

    public async install(desired: DesiredPlugin[]): Promise<PluginInstallResult> {
        const { dir } = this.options;
        fs.mkdirSync(dir, { recursive: true });
        const errors: { name: string; message: string }[] = [];
        // Tokens can change or be removed without anything else changing, so this is rewritten on every start.
        this.writeNpmrc();

        // Without the integrity hash recorded when a registry plugin was added, nothing proves the registry still serves
        // the same package. (A local `sources` tarball has none, and isn't checked.)
        const plugins: DesiredPlugin[] = [];
        for (const plugin of desired) {
            if (!this.options.sources?.[plugin.name] && !plugin.integrity) {
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
                    );
                } catch (err: any) {
                    // One unavailable package fails the whole install, so every plugin is reported as not loaded.
                    const installFailures: number = (Number(this.readJson(failuresFile)) || 0) + 1;
                    fs.writeFileSync(failuresFile, String(installFailures));
                    return { installed: [], errors: [...errors, ...plugins.map((plugin) => ({ name: plugin.name, message: err.message }))], installFailures };
                }
            }
            fs.writeFileSync(stampFile, JSON.stringify({ ...stamp, complete: true }));
            fs.rmSync(failuresFile, { force: true });
        }

        const lock: any = this.readJson(path.join(dir, "package-lock.json")) ?? {};
        const bundledPeers: Map<string, string> = this.findBundledPeers(plugins, lock);
        const installed: InstalledPlugin[] = [];
        for (const plugin of plugins) {
            try {
                installed.push(this.check(plugin, lock, bundledPeers.get(plugin.name)));
            } catch (err: any) {
                errors.push({ name: plugin.name, message: err.message });
            }
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
            if (installedIntegrity !== plugin.integrity) {
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
        return { name: plugin.name, version: pkg.version, manifest, entryUrl: pathToFileURL(entry).href };
    }
}
