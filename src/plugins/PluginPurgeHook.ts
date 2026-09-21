///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";
import type { DesiredPlugin, InstalledPlugin, PluginInstallResult } from "./PluginInstaller.js";
import { removeContained } from "./PluginPurgeFiles.js";
import type { PluginOwnedModel } from "./PluginPurgeTypes.js";

/** The package subpath a plugin exports its purge hook from (`package.json` `exports["./purge"]`). */
export const PURGE_HOOK_EXPORT = "./purge";

/** How long a plugin's `onPurge` hook may run before it is stopped, when not configured. */
export const DEFAULT_PURGE_HOOK_TIMEOUT_MS = 60_000;

/**
 * What a plugin's `onPurge(ctx)` hook receives, after the plugin was uninstalled and no server copy runs it. The hook
 * cleans up what the automatic purge can't know about: external resources, files or blobs, data outside its models.
 * The automatic purge (its models' collections and tables, its saved settings) runs after the hook.
 */
export interface PluginPurgeContext {
    plugin: { name: string; version: string };
    /** The collections and tables the automatic purge will delete afterwards, for information. */
    models: readonly PluginOwnedModel[];
    /** The server's connection for a datastore name (`mongo`, `sql`): a service-core `MongoConnection` or a TypeORM
     * `DataSource`. `undefined` for a datastore that isn't connected. */
    connection(datastore: string): unknown;
    /** The server's `BlobStore`, when one is configured. */
    blobStore?: unknown;
    /** The server's config (`get(key)`). */
    config: { get(key: string): unknown };
    logger: { info(message: string): void; warn(message: string): void; error(message: string): void };
    /** Aborted when the hook has run out of time; stop working. */
    signal: AbortSignal;
}

/** The shape of a plugin's `./purge` module. */
export interface PluginPurgeModule {
    onPurge?: (ctx: PluginPurgeContext) => void | Promise<void>;
    default?: { onPurge?: (ctx: PluginPurgeContext) => void | Promise<void> } | ((ctx: PluginPurgeContext) => void | Promise<void>);
}

/** What running the hook came to. */
export interface PurgeHookOutcome {
    /** `false` when the plugin has no hook (nothing ran). */
    ran: boolean;
}

/** Runs a plugin's `onPurge` hook. */
export interface PurgeHookRunner {
    run(plugin: { name: string; packageVersion: string; integrity?: string }, context: Omit<PluginPurgeContext, "signal">, timeoutMs: number): Promise<PurgeHookOutcome>;
}

/** The file a package's `exports["./purge"]` entry points at, for the `import` condition. */
export function purgeHookTarget(pkg: any): string | undefined {
    const entry: any = pkg?.exports?.[PURGE_HOOK_EXPORT];
    if (typeof entry === "string") {
        return entry;
    }
    return entry?.import ?? entry?.default;
}

/** Whether the package at `packageDir` exports a purge hook. */
export function hasPurgeHook(packageDir: string | undefined): boolean {
    if (!packageDir) {
        return false;
    }
    try {
        return purgeHookTarget(JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf8"))) !== undefined;
    } catch {
        return false;
    }
}

/** A duration for a message: seconds, or milliseconds when it is under a second. */
const duration = (ms: number): string => (ms < 1000 ? `${ms}ms` : `${Math.round(ms / 1000)}s`);

/** Rejects after `ms`, aborting `controller`, unless `work` settles first. */
async function withTimeout<R>(work: Promise<R>, ms: number, controller: AbortController, message: string): Promise<R> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            controller.abort();
            reject(new Error(message));
        }, ms);
    });
    try {
        return await Promise.race([work, timeout]);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Runs a plugin's hook from a copy of its package installed for the purpose - the plugin is uninstalled, so no server
 * copy has it on disk. The package is installed (and verified against the integrity hash recorded when it was added) into
 * `<plugins dir>/.purge/<name>`, imported from there, and deleted again afterwards. Nothing is installed for a plugin
 * whose inventory says it has no hook.
 */
export class InstallingPurgeHookRunner implements PurgeHookRunner {
    constructor(
        /** Makes an installer that installs into the given scratch directory. */
        private readonly createInstaller: (dir: string) => { install(desired: DesiredPlugin[]): Promise<PluginInstallResult> },
        /** `<plugins dir>/.purge`, holding the scratch installs. */
        private readonly scratchRoot: string,
        private readonly importModule: (url: string) => Promise<PluginPurgeModule> = (url) => import(url),
    ) {}

    /** The scratch directory of `pluginName`. Not shared between plugins, and never outside `scratchRoot`. */
    public scratchDir(pluginName: string): string {
        return path.join(this.scratchRoot, pluginName.replace(/^@/, "").replace(/[^A-Za-z0-9._-]/g, "_"));
    }

    public async run(
        plugin: { name: string; packageVersion: string; integrity?: string },
        context: Omit<PluginPurgeContext, "signal">,
        timeoutMs: number,
    ): Promise<PurgeHookOutcome> {
        const scratch: string = this.scratchDir(plugin.name);
        try {
            const result: PluginInstallResult = await withTimeout(
                this.createInstaller(scratch).install([{ name: plugin.name, packageVersion: plugin.packageVersion, integrity: plugin.integrity }]),
                timeoutMs,
                new AbortController(),
                `Installing ${plugin.name}@${plugin.packageVersion} to run its purge hook took longer than ${duration(timeoutMs)}.`,
            );
            const installed: InstalledPlugin | undefined = result.installed.find((candidate) => candidate.name === plugin.name);
            if (!installed?.packageDir) {
                throw new Error(result.errors.find((error) => error.name === plugin.name)?.message ?? `${plugin.name} could not be installed to run its purge hook.`);
            }
            const pkg: any = JSON.parse(fs.readFileSync(path.join(installed.packageDir, "package.json"), "utf8"));
            const target: string | undefined = purgeHookTarget(pkg);
            if (!target) {
                return { ran: false };
            }
            const file: string = path.resolve(fs.realpathSync(installed.packageDir), target);
            const loaded: PluginPurgeModule = await this.importModule(pathToFileURL(file).href);
            const fn: ((ctx: PluginPurgeContext) => void | Promise<void>) | undefined =
                loaded.onPurge ??
                (typeof loaded.default === "function" ? loaded.default : loaded.default?.onPurge);
            if (typeof fn !== "function") {
                throw new Error(`The plugin's ${PURGE_HOOK_EXPORT} entry point exports no onPurge function.`);
            }
            const controller: AbortController = new AbortController();
            await withTimeout(
                Promise.resolve().then(() => fn({ ...context, signal: controller.signal })),
                timeoutMs,
                controller,
                `The plugin's onPurge hook took longer than ${duration(timeoutMs)} and was stopped.`,
            );
            return { ran: true };
        } finally {
            try {
                removeContained(this.scratchRoot, scratch);
            } catch {
                // Left for the next run to try again; it holds nothing but the plugin's own package.
            }
        }
    }
}
