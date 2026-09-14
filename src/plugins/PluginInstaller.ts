///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { execFile } from "child_process";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";
import { parsePluginManifest, type PluginManifest } from "@rapidmx/restapi";

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
}

export interface PluginInstallerOptions {
    /** Where plugins are installed. Must sit below the server's own directory, so a plugin's imports of the shared
     * peers resolve upward to the server's copies. */
    dir: string;
    /** The server's own directory (the one holding its `node_modules`). */
    appRoot: string;
    registry: string;
    registryToken?: string;
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

    public async install(plugins: DesiredPlugin[]): Promise<PluginInstallResult> {
        const { dir } = this.options;
        fs.mkdirSync(dir, { recursive: true });
        const errors: { name: string; message: string }[] = [];

        const dependencies: Record<string, string> = {};
        for (const plugin of plugins) {
            const source: string | undefined = this.options.sources?.[plugin.name];
            dependencies[plugin.name] = source ? `file:${path.resolve(source)}` : plugin.packageVersion;
        }
        const manifest = { name: "rapidmx-plugins", private: true, dependencies };
        const stamp: string = crypto.createHash("sha256").update(JSON.stringify([manifest, this.options.registry])).digest("hex");
        const stampFile: string = path.join(dir, ".install-stamp");

        const upToDate: boolean =
            fs.existsSync(stampFile) && fs.readFileSync(stampFile, "utf8") === stamp && fs.existsSync(path.join(dir, "node_modules"));
        if (!upToDate) {
            fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(manifest, null, 2));
            fs.rmSync(path.join(dir, "package-lock.json"), { force: true });
            fs.rmSync(stampFile, { force: true });
            this.writeNpmrc();
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
                    return { installed: [], errors: plugins.map((plugin) => ({ name: plugin.name, message: err.message })) };
                }
            }
            fs.writeFileSync(stampFile, stamp);
        }

        const lock: any = this.readLock();
        const installed: InstalledPlugin[] = [];
        for (const plugin of plugins) {
            try {
                installed.push(this.check(plugin, lock));
            } catch (err: any) {
                errors.push({ name: plugin.name, message: err.message });
            }
        }
        return { installed, errors };
    }

    private writeNpmrc(): void {
        const npmrc: string = path.join(this.options.dir, ".npmrc");
        if (!this.options.registryToken) {
            fs.rmSync(npmrc, { force: true });
            return;
        }
        const host: string = this.options.registry.replace(/^https?:/, "").replace(/\/?$/, "/");
        fs.writeFileSync(npmrc, `${host}:_authToken=${this.options.registryToken}\n`, { mode: 0o600 });
    }

    private readLock(): any {
        try {
            return JSON.parse(fs.readFileSync(path.join(this.options.dir, "package-lock.json"), "utf8"));
        } catch {
            return {};
        }
    }

    private check(plugin: DesiredPlugin, lock: any): InstalledPlugin {
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
            if (plugin.integrity && installedIntegrity !== plugin.integrity) {
                throw new Error("The installed package's integrity hash doesn't match the one recorded when it was added.");
            }
        }

        const manifest: PluginManifest | string = parsePluginManifest(pkg);
        if (typeof manifest === "string") {
            throw new Error(manifest);
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
