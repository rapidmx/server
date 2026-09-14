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
    PluginRegistry,
    type Plugin,
    type PluginNamespace,
} from "@rapidmx/restapi";
import { PluginClassLoader } from "./PluginClassLoader.js";
import { PluginInstaller, type PluginInstallResult } from "./PluginInstaller.js";
import { findAllPlugins, PluginStateStore, type DefaultPlugin } from "./PluginStateStore.js";
import { PluginWatcher } from "./PluginWatcher.js";

/** Set by the supervisor after repeated failed starts: the server then starts with no plugins at all. */
export const PLUGIN_SAFE_MODE_ENV = "RAPIDMX_PLUGINS_SAFE_MODE";

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
}

/**
 * Prepares a server process's plugins before the server starts, and keeps them in step while it runs:
 *
 * 1. Reads the plugin table (seeding `system:plugins:defaults` on first sight).
 * 2. Installs the enabled plugins with npm (`PluginInstaller`).
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
        errors.push(...result.errors);
        for (const error of result.errors) {
            logger.error(`Plugin ${error.name} was not loaded: ${error.message}`);
        }

        // Saved settings go into config before any plugin class is instantiated. Settings of plugins that failed to
        // install are left out, since nothing will read them.
        const installedNames: Set<string> = new Set(result.installed.map((plugin) => plugin.name));
        for (const row of enabled.filter((plugin) => installedNames.has(plugin.name))) {
            for (const [key, value] of Object.entries(row.settings ?? {})) {
                config.set(key, value);
            }
        }
        PluginRegistry.setLoaded(result.installed.map((plugin) => ({ name: plugin.name, version: plugin.version })));

        return new PluginHost(options, computePluginStateHash(safeMode ? [] : rows), errors, safeMode, result.installed);
    }

    /** Starts watching for plugin changes once the server is running. `restart` stops this process so its supervisor
     * can start a new one. */
    public async start(objectFactory: ObjectFactory, restart: () => Promise<void>): Promise<void> {
        const { config, logger, datastore, pluginClass } = this.options;
        // Entry points that failed to import are only known once the server has loaded its classes.
        PluginRegistry.setLoaded(this.classLoader.loaded.map((plugin) => ({ name: plugin.name, version: plugin.version })));
        this.watcher = new PluginWatcher({
            instance: config.get("system:plugins:instance_id") || os.hostname(),
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
            cacheUrl: config.get("datastores:cache:url"),
            logger,
        });
        await this.watcher.start();
    }

    public async stop(): Promise<void> {
        await this.watcher?.stop();
    }
}
