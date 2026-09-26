///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import os from "os";
import path from "path";
import { ConnectionManager, ObjectFactory } from "@rapidrest/service-core";
import {
    computePluginStateHash,
    DEFAULT_PLUGIN_NAMESPACES,
    DEFAULT_PLUGIN_REGISTRY,
    findPluginNamespace,
    findPluginUiMountConflicts,
    normalizePluginNamespaces,
    NpmRegistryClient,
    orderByDependencies,
    PluginRegistry,
    pruneUnmetRequirements,
    recordAuditLog,
    type AuditAction,
    type Plugin,
    type PluginNamespace,
} from "@rapidmx/restapi";
import { applyPluginSetting } from "../config.defaults.js";
import { PluginClassLoader, type PluginUiLoadOptions } from "./PluginClassLoader.js";
import { PluginInstaller, type PluginInstallerOptions, type PluginInstallResult } from "./PluginInstaller.js";
import { describeModels } from "./PluginOwnedData.js";
import { clearRemovedPluginSettings, findAllPlugins, pluginRepository, PluginStateStore, type DefaultPlugin } from "./PluginStateStore.js";
import { clearStarting, markStarting, RedisPurgeCoordination } from "./PluginPurgeCoordination.js";
import { hasPurgeHook, InstallingPurgeHookRunner, type PurgeHookRunner } from "./PluginPurgeHook.js";
import { DEFAULT_PURGE_LEASE_MS, PluginPurgeLedger } from "./PluginPurgeLedger.js";
import { PluginPurgeStore } from "./PluginPurgeStore.js";
import { DEFAULT_PURGE_CHECK_MS, DEFAULT_PURGE_GRACE_MS, PluginPurger, setPluginPurger } from "./PluginPurger.js";
import type { PluginOwnedModel } from "./PluginPurgeTypes.js";
import { PluginUiBuilder, type PluginUiBuildResult } from "./PluginUiBuilder.js";
import type { PluginUiHostClasses } from "./PluginUiRoutes.js";
import {
    createWatcherRedisClient,
    DEFAULT_LOCK_TTL_MS,
    PluginRestartLock,
    PluginWatcher,
    type PluginWatcherOptions,
    type WatcherRedisClient,
} from "./PluginWatcher.js";
import { notifyPluginsLoaded, SAFE_MODE_ATTEMPT_ENV, SAFE_MODE_BASELINE_ENV } from "./supervisor.js";

/** Set by the supervisor after repeated failed starts: the server then starts with no plugins at all. */
export const PLUGIN_SAFE_MODE_ENV = "RAPIDMX_PLUGINS_SAFE_MODE";

/**
 * How long to wait before restarting to retry after `failures` failed attempts in a row: `baseMs`, doubling with each
 * further failure, up to `maxMs` - so a registry outage is retried soon, and a package that can never install doesn't
 * restart the server over and over.
 */
export function installRetryDelayMs(failures: number, baseMs: number = 60_000, maxMs: number = 10 * 60_000): number {
    return Math.min(maxMs, baseMs * 2 ** Math.max(0, Math.min(failures - 1, 30)));
}

/** How many npm failures in a row are retried by restarting, when not configured. */
export const DEFAULT_INSTALL_RETRY_MAX_ATTEMPTS = 6;

/** How long a restarted copy may take to start serving while holding the restart lock, when not configured. */
export const DEFAULT_MAX_LOCK_HOLD_MS = 15 * 60_000;

export interface PluginHostOptions {
    config: any;
    logger: any;
    /** The datastore name the server's models use (`mongo` or `sql`), which is also the plugin entry point. */
    datastore: "mongo" | "sql";
    /** The server's `Plugin` model for that datastore. */
    pluginClass: any;
    /** The server's own directory. */
    appRoot: string;
    /** The base route of each plugin UI host for this datastore (see `PluginUiRoutes.ts`). Without them no plugin UI is
     * built or served. */
    uiHosts?: PluginUiHostClasses;
    /** What deleting an uninstalled plugin's data needs for this datastore: the server's `PluginPurgeMongo`/`PluginPurgeSQL`
     * model and restapi's audit log model. Without it uninstalled plugins' data is never deleted. */
    purge?: { purgeClass: any; auditLogClass: any };
    /** Test seams. */
    store?: PluginStateStore;
    installer?: PluginInstaller;
    uiBuilder?: Pick<PluginUiBuilder, "build">;
    registry?: NpmRegistryClient;
    createRedisClient?: (url: string) => WatcherRedisClient;
    /** Replaces the purge's reading of the other copies' status (see `RedisPurgeCoordination`). */
    purgeCoordination?: { configured: boolean; snapshot(): Promise<any> };
    /** Replaces running a plugin's purge hook from a scratch install (see `InstallingPurgeHookRunner`). */
    purgeHooks?: PurgeHookRunner;
}

/** The restart lock and the cache connection holding it, opened before plugins install. */
interface RestartLockConnection {
    cache: WatcherRedisClient;
    lock: PluginRestartLock;
}

/**
 * Prepares a server process's plugins before the server starts, and keeps them in step while it runs:
 *
 * 1. Reads the plugin table (seeding `system:plugins:defaults` on first sight).
 * 2. Installs the enabled plugins with npm (`PluginInstaller`), skips any whose required plugins aren't loaded, and
 * orders the rest so each plugin loads after the plugins it requires.
 * 3. Merges each plugin's saved settings into config, so its `@Config` values see them.
 * 4. Hands the server a `PluginClassLoader` that adds the plugins' routes, models and jobs to its own.
 * 5. Once the server is up, runs a `PluginWatcher` that restarts the process when the plugin set changes.
 *
 * Nothing here stops the server from starting: a plugin that can't be read, installed or loaded is reported in
 * the admin console's status instead.
 */
export class PluginHost {
    public readonly classLoader: PluginClassLoader;
    private watcher?: PluginWatcher;
    private purger?: PluginPurger;
    private lockClosed: boolean = false;

    private constructor(
        private readonly options: PluginHostOptions,
        public readonly loadedHash: string,
        private readonly errors: { name: string; message: string }[],
        public readonly safeMode: boolean,
        installed: PluginInstallResult["installed"],
        ui: PluginUiLoadOptions,
        /** How this copy retries and whether it holds up other copies' restarts - see `PluginWatcherOptions`. */
        public readonly retry: Pick<PluginWatcherOptions, "retryDelayMs" | "haltRollout" | "safeModeBaseline" | "safeModeRetryMs">,
        private readonly restartLock?: RestartLockConnection,
        /** What running a purge hook needs: the installer's options (the hook's package is installed into a scratch directory). */
        private readonly purgeEnv?: { pluginsDir: string; installer: PluginInstallerOptions },
    ) {
        const { config, logger } = options;
        this.classLoader = new PluginClassLoader(
            config.get("base_path"),
            config.get("class_loader:ignore"),
            installed,
            logger,
            () => notifyPluginsLoaded(loadedHash),
            ui,
        );
    }

    /** Set when plugins failed to install: how long until restarting to try again. */
    public get retryDelayMs(): number | undefined {
        return this.retry.retryDelayMs;
    }

    public static async prepare(options: PluginHostOptions): Promise<PluginHost> {
        const { config, logger, datastore, appRoot } = options;
        const registryUrl: string = config.get("system:plugins:registry") || DEFAULT_PLUGIN_REGISTRY;
        const registryToken: string | undefined = config.get("system:plugins:registry_token") || undefined;
        const sources: Record<string, string> = config.get("system:plugins:sources") || {};
        const defaults: DefaultPlugin[] = config.get("system:plugins:defaults") || [];
        const namespaces: PluginNamespace[] = normalizePluginNamespaces(config.get("system:plugins:namespaces") ?? DEFAULT_PLUGIN_NAMESPACES);
        // A package in a namespace with its own registry is read from that registry, like npm's scoped registries.
        const registryFor = (packageName: string): NpmRegistryClient => {
            if (options.registry) {
                return options.registry;
            }
            const namespace: PluginNamespace | undefined = findPluginNamespace(packageName, namespaces);
            return namespace?.registry ? new NpmRegistryClient(namespace.registry, namespace.token) : new NpmRegistryClient(registryUrl, registryToken);
        };
        const safeMode: boolean = process.env[PLUGIN_SAFE_MODE_ENV] === "1";
        const errors: { name: string; message: string }[] = [];
        // If this copy restarted to apply a plugin change, it still holds the restart lock: keep it alive through the
        // install, so the next copy doesn't stop before this one is serving again - but let it expire if this start crashes.
        const restartLock: RestartLockConnection | undefined = await PluginHost.resumeRestartLock(options);

        if (restartLock) {
            restartLock.lock.limitHold(config.get("system:plugins:restart:max_lock_hold_ms") ?? DEFAULT_MAX_LOCK_HOLD_MS);
        }

        let rows: Plugin[] = [];
        // Whether `rows` is the plugin table as it is. Not in safe mode, or when it couldn't be read - and then nothing
        // installed earlier is removed on account of the empty list.
        let known: boolean = false;
        if (safeMode) {
            logger.warn("Starting without plugins: recent starts failed after loading them. Fix or disable the failing plugin; they're also tried again automatically.");
        } else {
            const store: PluginStateStore = options.store ?? new PluginStateStore(config, logger, datastore, options.pluginClass);
            try {
                rows = await store.loadAndSeed(defaults, registryFor, sources);
                known = true;
            } catch (err: any) {
                logger.error(`Could not read the plugin list, so no plugins were loaded: ${err.message}`);
                errors.push({ name: "*", message: `Could not read the plugin list: ${err.message}` });
            }
        }

        const enabled: Plugin[] = rows.filter((row) => row.enabled && !row.removed);
        const pluginsDir: string = config.get("system:plugins:dir") || path.join(appRoot, "plugins");
        const installerOptions: PluginInstallerOptions = {
            dir: pluginsDir,
            appRoot,
            registry: registryUrl,
            registryToken,
            namespaces,
            sources,
            datastore,
            logger,
            npmTimeoutMs: config.get("system:plugins:npm_timeout_ms") ?? undefined,
            requireIntegrity: config.get("system:plugins:require_integrity") ?? true,
            maxInstallBytes: config.get("system:plugins:max_install_bytes") ?? undefined,
        };
        const installer: PluginInstaller = options.installer ?? new PluginInstaller(installerOptions);
        const result: PluginInstallResult = known
            ? await installer.install(enabled.map((row) => ({ name: row.name, packageVersion: row.packageVersion, integrity: row.integrity })))
            : { installed: [], errors: [] };
        // A plugin whose required plugins didn't all install, in range, is skipped too - and so is anything requiring it.
        // What's left loads in dependency order, so a plugin's requirements are registered before it.
        const { kept, dropped } = pruneUnmetRequirements(result.installed);
        const installed: PluginInstallResult["installed"] = orderByDependencies(kept);
        errors.push(...result.errors, ...dropped);
        for (const error of [...result.errors, ...dropped]) {
            logger.error(`Plugin ${error.name} was not loaded: ${error.message}`);
        }

        // Saved settings go into config before any plugin class is instantiated. Settings of plugins that failed to
        // install are left out, since nothing will read them.
        const installedNames: Set<string> = new Set(installed.map((plugin) => plugin.name));
        for (const row of enabled.filter((plugin) => installedNames.has(plugin.name))) {
            for (const [key, value] of Object.entries(row.settings ?? {})) {
                // An empty value (or null) means "not set": a plugin's manifest may declare "" as a default, which is saved when
                // the plugin is installed. It must not be applied, or it would hide the deployment's own configuration for the
                // same key (the Helm chart's bundled coturn sets mail:videoconf:turn:* through the environment, for one). A
                // value that is set goes in the top configuration layer, so it wins over the environment and the defaults.
                if (value !== "" && value !== null && value !== undefined) {
                    applyPluginSetting(config, key, value);
                }
            }
        }
        PluginRegistry.setLoaded(installed.map((plugin) => ({ name: plugin.name, version: plugin.version })));

        // Plugins' UI apps are built into the browser bundles before the server starts, which then serves that build.
        // In safe mode, or without the plugin list, nothing is built, and earlier builds are kept for when plugins return.
        const ui: PluginUiLoadOptions = { hosts: options.uiHosts, failed: new Map(), refusedMounts: new Map() };
        if (known && !safeMode && options.uiHosts) {
            await PluginHost.prepareUi(options, pluginsDir, installed, ui, errors);
        }

        // npm failing (say, the registry is down) isn't the plugins' fault: try again later rather than running without them
        // until the next unrelated restart - but not for an error retrying won't fix, nor forever.
        let retryDelayMs: number | undefined;
        if (result.installFailures) {
            const maxAttempts: number = config.get("system:plugins:restart:install_retry_max_attempts") ?? DEFAULT_INSTALL_RETRY_MAX_ATTEMPTS;
            if (result.installFailurePermanent || result.installFailures >= maxAttempts) {
                const why: string = result.installFailurePermanent ? "npm reported an error retrying won't fix" : `npm failed ${result.installFailures} times in a row`;
                const message: string = `Plugins failed to install and won't be retried automatically (${why}). Fix the plugin or registry, then change the plugin or restart the server.`;
                logger.error(message);
                errors.push({ name: "*", message });
            } else {
                retryDelayMs = installRetryDelayMs(
                    result.installFailures,
                    config.get("system:plugins:restart:install_retry_ms") ?? undefined,
                    config.get("system:plugins:restart:install_retry_max_ms") ?? undefined,
                );
            }
        }

        const attempt: number = Number(process.env[SAFE_MODE_ATTEMPT_ENV]) || 1;
        const retry: PluginHost["retry"] = safeMode
            ? {
                  safeModeBaseline: process.env[SAFE_MODE_BASELINE_ENV] || undefined,
                  safeModeRetryMs: installRetryDelayMs(
                      attempt,
                      config.get("system:plugins:restart:safe_mode_retry_ms") ?? 5 * 60_000,
                      config.get("system:plugins:restart:safe_mode_retry_max_ms") ?? 60 * 60_000,
                  ),
              }
            : { retryDelayMs, haltRollout: !!result.installFailures };

        return new PluginHost(options, computePluginStateHash(safeMode ? [] : rows), errors, safeMode, installed, ui, retry, restartLock, {
            pluginsDir,
            installer: installerOptions,
        });
    }

    /**
     * Leaves out plugin UI apps whose mounts overlap an earlier plugin's, builds the rest (`PluginUiBuilder`) and points
     * `react:manifestPath` at the build. Failures are recorded in `ui` and `errors`, never thrown.
     */
    private static async prepareUi(
        options: PluginHostOptions,
        pluginsDir: string,
        installed: PluginInstallResult["installed"],
        ui: PluginUiLoadOptions,
        errors: { name: string; message: string }[],
    ): Promise<void> {
        const { config, logger, appRoot } = options;
        // Hosts share one URL space: the first plugin (in load order) to claim a path keeps it.
        for (const conflict of findPluginUiMountConflicts(installed)) {
            const plugin = installed.find((candidate) => candidate.name === conflict.name);
            if (!plugin?.uiApps?.some((app) => app.mount === conflict.mount)) {
                continue;
            }
            plugin.uiApps = plugin.uiApps.filter((app) => app.mount !== conflict.mount);
            ui.refusedMounts!.set(plugin.name, [...(ui.refusedMounts!.get(plugin.name) ?? []), conflict.mount]);
            const message: string = `Its UI app at ${conflict.mount} isn't served: ${conflict.message}`;
            logger.error(`Plugin ${plugin.name}: ${message}`);
            errors.push({ name: plugin.name, message });
        }

        const configuredManifest: string = config.get("react:manifestPath") || "dist/public/.vite/manifest.json";
        let result: PluginUiBuildResult;
        try {
            const builder: Pick<PluginUiBuilder, "build"> =
                options.uiBuilder ?? new PluginUiBuilder({ pluginsDir, appRoot, logger, prebuiltOutDir: path.dirname(path.dirname(configuredManifest)) });
            result = await builder.build(installed);
        } catch (err: any) {
            const message: string = `The plugin's UI wasn't built: ${err.message}`;
            logger.error(`Plugin UI wasn't built: ${err.stack ?? err.message}`);
            result = { built: [], failed: PluginUiBuilder.uiPlugins(installed).map((plugin) => ({ name: plugin.name, message })) };
        }
        for (const failure of result.failed) {
            ui.failed!.set(failure.name, failure.message);
            errors.push(failure);
        }
        if (result.manifestPath) {
            config.set("react:manifestPath", result.manifestPath);
            if (config.get("react:manifestPath") !== result.manifestPath) {
                logger.warn(`react:manifestPath is set in the environment or arguments, so the plugin UI build at ${result.manifestPath} isn't served.`);
            }
        }
    }

    private static instanceId(config: any): string {
        return config.get("system:plugins:instance_id") || os.hostname();
    }

    private static async resumeRestartLock(options: PluginHostOptions): Promise<RestartLockConnection | undefined> {
        const { config, logger } = options;
        const url: string | undefined = config.get("datastores:cache:url");
        if (!url) {
            return undefined;
        }
        let cache: WatcherRedisClient | undefined;
        try {
            cache = options.createRedisClient ? options.createRedisClient(url) : createWatcherRedisClient(url, logger);
            await cache.connect();
            const ttlMs: number = config.get("system:plugins:restart:lock_ttl_ms") ?? DEFAULT_LOCK_TTL_MS;
            const lock: PluginRestartLock = new PluginRestartLock(cache, PluginHost.instanceId(config), ttlMs, logger);
            await lock.resume();
            // Until this copy reports what it loaded (the watcher, once the server is up) it is invisible in the status,
            // yet may load a plugin that is being uninstalled: a purge of that plugin's data waits for this to clear.
            await markStarting(cache, PluginHost.instanceId(config)).catch((err: any) => logger.debug?.(`Could not mark this copy as starting: ${err.message}`));
            return { cache, lock };
        } catch (err: any) {
            logger.warn(`Plugin status reporting is unavailable: ${err.message}`);
            await (cache?.quit?.() ?? cache?.disconnect?.())?.catch(() => undefined);
            return undefined;
        }
    }

    /** Starts watching for plugin changes once the server is running. `restart` stops this process so its supervisor
     * can start a new one. */
    public async start(objectFactory: ObjectFactory, restart: () => Promise<void>): Promise<void> {
        const { config, logger, datastore, pluginClass } = this.options;
        // Entry points that failed to import are only known once the server has loaded its classes.
        PluginRegistry.setLoaded(this.classLoader.registryEntries());
        // Serving now: the watcher releases the restart lock once this copy has been ready a little while.
        this.restartLock?.lock.clearHoldLimit();
        this.watcher = new PluginWatcher({
            instance: PluginHost.instanceId(config),
            loadedHash: this.loadedHash,
            status: {
                loaded: this.classLoader.registryEntries().map(({ name, version, ui }) => ({
                    name,
                    version,
                    ...(ui ? { ui: { status: ui.status, mounts: ui.mounts, ...(ui.error ? { error: ui.error } : {}) } } : {}),
                })),
                errors: [...this.errors, ...this.classLoader.errors],
                safeMode: this.safeMode,
            },
            readPlugins: async () => {
                const connection: any = objectFactory.getInstance<ConnectionManager>(ConnectionManager)?.connections.get(datastore);
                return findAllPlugins(pluginRepository(connection, pluginClass));
            },
            restart,
            eventsUrl: config.get("datastores:events:url"),
            // Already connected in prepare() when the cache was reachable then; otherwise the watcher tries again.
            cacheUrl: config.get("datastores:cache:url"),
            cache: this.restartLock?.cache,
            lock: this.restartLock?.lock,
            lockTtlMs: config.get("system:plugins:restart:lock_ttl_ms") ?? undefined,
            lockReleaseDelayMs: config.get("system:plugins:restart:lock_release_delay_ms") ?? undefined,
            drainDelayMs: config.get("system:plugins:restart:drain_delay_ms") ?? undefined,
            restartJitterMs: config.get("system:plugins:restart:jitter_ms") ?? undefined,
            ...this.retry,
            createRedisClient: this.options.createRedisClient,
            logger,
        });
        await this.watcher.start();
        if (this.restartLock) {
            await clearStarting(this.restartLock.cache, PluginHost.instanceId(config)).catch(() => undefined);
        }
        await this.startPurger(objectFactory);
    }

    /**
     * Records which collections and tables each loaded plugin's models use (what a later purge of its data deletes), and
     * starts looking for uninstalled plugins whose data is waiting to be deleted (`PluginPurger`). Never fails the start.
     */
    private async startPurger(objectFactory: ObjectFactory): Promise<void> {
        const { config, logger, datastore, pluginClass, purge } = this.options;
        if (!purge || !this.purgeEnv) {
            return;
        }
        try {
            const connections = objectFactory.getInstance<ConnectionManager>(ConnectionManager)!.connections;
            const connection: any = connections.get(datastore);
            const leaseMs: number = config.get("system:plugins:purge:lease_ms") ?? DEFAULT_PURGE_LEASE_MS;
            const ledger: PluginPurgeLedger = new PluginPurgeLedger(new PluginPurgeStore(connection, purge.purgeClass), leaseMs);

            const loadedModels: Map<string, PluginOwnedModel[]> = new Map();
            for (const plugin of this.classLoader.loaded) {
                const { models, skipped } = describeModels(this.classLoader.classesOf(plugin.name), connections);
                for (const entry of skipped) {
                    logger.warn(`Plugin ${plugin.name}'s ${entry.className} isn't recorded for data deletion: ${entry.reason}.`);
                }
                loadedModels.set(plugin.name, models);
                await ledger
                    .recordInventory(plugin.name, { version: plugin.version, hook: hasPurgeHook(plugin.packageDir), models })
                    .catch((err: any) => logger.warn(`Could not record what plugin ${plugin.name} stores: ${err.message}`));
            }

            const { pluginsDir, installer } = this.purgeEnv;
            const instance: string = PluginHost.instanceId(config);
            this.purger = new PluginPurger({
                instance,
                config,
                logger,
                ledger,
                leaseMs,
                coordination: this.options.purgeCoordination ?? new RedisPurgeCoordination(config.get("datastores:cache:url"), logger, this.options.createRedisClient),
                connections,
                coreClasses: () => this.classLoader.coreClasses(),
                loadedPlugins: () => loadedModels,
                readRows: () => findAllPlugins(pluginRepository(connection, pluginClass)),
                clearSettings: (row) => clearRemovedPluginSettings(connection, pluginClass, row.uid),
                hooks: this.options.purgeHooks ?? new InstallingPurgeHookRunner((dir) => new PluginInstaller({ ...installer, dir }), path.join(pluginsDir, ".purge")),
                hookContext: () => ({
                    connection: (name: string) => connections.get(name),
                    blobStore: objectFactory.getInstance("BlobStore"),
                    config,
                    logger,
                }),
                pluginsDir,
                keepBuild: () => {
                    const manifest: string | undefined = config.get("react:manifestPath");
                    return manifest ? path.dirname(path.dirname(path.resolve(manifest))) : undefined;
                },
                audit: async (action, plugin, details) =>
                    recordAuditLog(
                        objectFactory,
                        purge.auditLogClass,
                        { config, logger },
                        { action: action as AuditAction, targetType: "Plugin", targetUid: plugin.uid ?? plugin.name, details: { name: plugin.name, ...details } },
                    ),
                checkIntervalMs: config.get("system:plugins:purge:check_ms") ?? DEFAULT_PURGE_CHECK_MS,
                initialDelayMs: config.get("system:plugins:purge:initial_delay_ms") ?? undefined,
                graceMs: config.get("system:plugins:purge:grace_ms") ?? DEFAULT_PURGE_GRACE_MS,
            });
            this.purger.start();
            setPluginPurger(this.purger);
        } catch (err: any) {
            logger.warn(`Deleting uninstalled plugins' data is unavailable: ${err.message}`);
        }
    }

    /** Stops watching for plugin changes. With `shutdown` (the process is stopping for good, not restarting), the restart
     * lock is given back even if this copy was part-way through a restart. */
    public async stop(options: { shutdown?: boolean } = {}): Promise<void> {
        if (this.purger) {
            setPluginPurger(undefined);
            await this.purger.stop();
            this.purger = undefined;
        }
        if (this.watcher) {
            await this.watcher.stop(options);
        } else if (this.restartLock && !this.lockClosed) {
            // The server never started: the watcher didn't take over the cache connection.
            this.lockClosed = true;
            this.restartLock.lock.stopRenewing();
            if (options.shutdown) {
                await this.restartLock.lock.release().catch(() => undefined);
            }
            await (this.restartLock.cache.quit?.() ?? this.restartLock.cache.disconnect?.())?.catch(() => undefined);
        }
    }
}
