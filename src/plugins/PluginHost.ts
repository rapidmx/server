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
    normalizePluginNamespaces,
    NpmRegistryClient,
    orderByDependencies,
    PluginRegistry,
    pruneUnmetRequirements,
    type Plugin,
    type PluginNamespace,
} from "@rapidmx/restapi";
import { PluginClassLoader } from "./PluginClassLoader.js";
import { PluginInstaller, type PluginInstallResult } from "./PluginInstaller.js";
import { findAllPlugins, PluginStateStore, type DefaultPlugin } from "./PluginStateStore.js";
import { createWatcherRedisClient, DEFAULT_LOCK_TTL_MS, PluginRestartLock, PluginWatcher, type WatcherRedisClient } from "./PluginWatcher.js";

/** Set by the supervisor after repeated failed starts: the server then starts with no plugins at all. */
export const PLUGIN_SAFE_MODE_ENV = "RAPIDMX_PLUGINS_SAFE_MODE";

/**
 * How long to wait before restarting to retry after `failures` failed plugin installs in a row: `baseMs`, doubling
 * with each further failure, up to `maxMs` - so a registry outage is retried soon, and a package that can never
 * install doesn't restart the server over and over.
 */
export function installRetryDelayMs(failures: number, baseMs: number = 60_000, maxMs: number = 10 * 60_000): number {
    return Math.min(maxMs, baseMs * 2 ** Math.max(0, Math.min(failures - 1, 30)));
}

export interface PluginHostOptions {
    config: any;
    logger: any;
    /** The datastore name the server's models use (`mongo` or `sql`), which is also the plugin entry point. */
    datastore: "mongo" | "sql";
    /** The server's `Plugin` model for that datastore. */
    pluginClass: any;
    /** The server's own directory. */
    appRoot: string;
    /** Test seams. */
    store?: PluginStateStore;
    installer?: PluginInstaller;
    registry?: NpmRegistryClient;
    createRedisClient?: (url: string) => WatcherRedisClient;
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

    private constructor(
        private readonly options: PluginHostOptions,
        public readonly loadedHash: string,
        private readonly errors: { name: string; message: string }[],
        public readonly safeMode: boolean,
        installed: PluginInstallResult["installed"],
        /** Set when plugins failed to install: how long until restarting to try again. */
        public readonly retryDelayMs?: number,
        private readonly restartLock?: RestartLockConnection,
    ) {
        const { config, logger } = options;
        this.classLoader = new PluginClassLoader(config.get("base_path"), config.get("class_loader:ignore"), installed, logger);
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

        let rows: Plugin[] = [];
        if (safeMode) {
            logger.warn("Starting without plugins: recent starts failed. Fix or disable the failing plugin, then restart.");
        } else {
            const store: PluginStateStore = options.store ?? new PluginStateStore(config, logger, datastore, options.pluginClass);
            try {
                rows = await store.loadAndSeed(defaults, registryFor, sources);
            } catch (err: any) {
                logger.error(`Could not read the plugin list, so no plugins were loaded: ${err.message}`);
                errors.push({ name: "*", message: `Could not read the plugin list: ${err.message}` });
            }
        }

        const enabled: Plugin[] = rows.filter((row) => row.enabled && !row.removed);
        const installer: PluginInstaller =
            options.installer ??
            new PluginInstaller({
                dir: config.get("system:plugins:dir") || path.join(appRoot, "plugins"),
                appRoot,
                registry: registryUrl,
                registryToken,
                namespaces,
                sources,
                datastore,
                logger,
            });
        const result: PluginInstallResult = await installer.install(
            enabled.map((row) => ({ name: row.name, packageVersion: row.packageVersion, integrity: row.integrity })),
        );
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
                config.set(key, value);
            }
        }
        PluginRegistry.setLoaded(installed.map((plugin) => ({ name: plugin.name, version: plugin.version })));

        // npm failing (say, the registry is down) isn't the plugins' fault: try again later rather than running without them
        // until the next unrelated restart.
        const retryDelayMs: number | undefined = result.installFailures
            ? installRetryDelayMs(
                  result.installFailures,
                  config.get("system:plugins:restart:install_retry_ms") ?? undefined,
                  config.get("system:plugins:restart:install_retry_max_ms") ?? undefined,
              )
            : undefined;

        return new PluginHost(options, computePluginStateHash(safeMode ? [] : rows), errors, safeMode, installed, retryDelayMs, restartLock);
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
        PluginRegistry.setLoaded(this.classLoader.loaded.map((plugin) => ({ name: plugin.name, version: plugin.version })));
        this.watcher = new PluginWatcher({
            instance: PluginHost.instanceId(config),
            loadedHash: this.loadedHash,
            status: {
                loaded: this.classLoader.loaded.map((plugin) => ({ name: plugin.name, version: plugin.version })),
                errors: [...this.errors, ...this.classLoader.errors],
                safeMode: this.safeMode,
            },
            readPlugins: async () => {
                const connection: any = objectFactory.getInstance<ConnectionManager>(ConnectionManager)?.connections.get(datastore);
                const repo: any =
                    typeof connection?.getMongoRepository === "function" ? connection.getMongoRepository(pluginClass) : connection.getRepository(pluginClass);
                return findAllPlugins(repo);
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
            retryDelayMs: this.retryDelayMs,
            createRedisClient: this.options.createRedisClient,
            logger,
        });
        await this.watcher.start();
    }

    public async stop(): Promise<void> {
        if (this.watcher) {
            await this.watcher.stop();
        } else if (this.restartLock) {
            // The server never started: the watcher didn't take over the cache connection.
            this.restartLock.lock.stopRenewing();
            await (this.restartLock.cache.quit?.() ?? this.restartLock.cache.disconnect?.())?.catch(() => undefined);
        }
    }
}
