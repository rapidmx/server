///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ClassLoader } from "@rapidrest/core";
import { PluginRegistry } from "@rapidmx/restapi";
import { fileURLToPath } from "url";
import path from "path";
import type { InstalledPlugin } from "./PluginInstaller.js";
import { manifestNav, type LoadedPluginWithUi } from "./pluginNav.js";
import {
    createPluginUiRoute,
    findRouteCollision,
    pluginUiRouteName,
    registeredRoutePaths,
    type PluginUiHostClasses,
    type RegisteredRoutePath,
} from "./PluginUiRoutes.js";

/** The class-name prefix a plugin's exports are registered under, e.g. `plugins.rapidmx_activesync`. */
export function pluginPackagePrefix(name: string): string {
    return `plugins.${name.replace(/^@/, "").replace(/[^A-Za-z0-9_]/g, "_")}`;
}

/** What the class loader needs to serve plugins' UI apps. */
export interface PluginUiLoadOptions {
    /** The base route of each host for this datastore. Without them, no plugin UI is served. */
    hosts?: PluginUiHostClasses;
    /** Plugins whose UI didn't build this start, with the reason. */
    failed?: Map<string, string>;
    /** Mounts of plugins' apps that were left out before building (they overlapped another plugin's). */
    refusedMounts?: Map<string, string[]>;
}

/**
 * The server's class loader plus its plugins: after the usual scan of the server's own base path, it imports
 * each installed plugin's datastore entry point and registers every export, so the server mounts the plugin's
 * routes, connects its models and starts its jobs exactly as it does its own.
 *
 * Then it registers a route for each UI app of a loaded plugin whose UI built (`plugins.<name>.ui.<id>`, see
 * `PluginUiRoutes.ts`), refusing an app whose mount clashes with a route already registered, and records each plugin's
 * UI state in `PluginRegistry`.
 *
 * A plugin whose entry point fails to import is skipped and reported through `errors`, rather than stopping the
 * server from starting.
 */
export class PluginClassLoader extends ClassLoader {
    public readonly errors: { name: string; message: string }[] = [];

    /** The plugins whose entry points imported cleanly. */
    public readonly loaded: InstalledPlugin[] = [];

    /**
     * Runs once every class - the server's own and the plugins' - is loaded, still inside `Server.start()` before it
     * connects its datastores: the point to adjust model metadata for all of them (see lib/sqlColumnTypes.ts).
     */
    public afterLoad?: (classes: Map<string, any>) => Promise<void>;

    /** Per loaded plugin: the mounts its UI routes were registered at, and the mounts that were refused. */
    private readonly uiMounts: Map<string, { mounts: string[]; refused: string[] }> = new Map();

    constructor(
        rootDir: string,
        ignore: RegExp[] | undefined,
        private readonly plugins: InstalledPlugin[],
        private readonly logger?: any,
        /** Called when the plugins' entry points are about to be imported (not at all when there are none). */
        private readonly onPluginsLoaded?: () => void,
        private readonly ui: PluginUiLoadOptions = {},
    ) {
        super(rootDir, true, true, ignore);
    }

    public async load(dir: string = ""): Promise<void> {
        await super.load(dir);
        // `load()` recurses through itself for subdirectories; plugins are added once, after the top-level scan.
        if (dir !== "") {
            return;
        }
        // Reported before importing, so a plugin that takes the process down as it's imported counts too.
        if (this.plugins.length > 0) {
            this.onPluginsLoaded?.();
        }
        for (const plugin of this.plugins) {
            const file: string = fileURLToPath(plugin.entryUrl);
            try {
                await (this as any).registerModule(file, pluginPackagePrefix(plugin.name), path.basename(file));
                this.loaded.push(plugin);
                this.logger?.info(`Loaded plugin ${plugin.name}@${plugin.version}.`);
            } catch (err: any) {
                this.errors.push({ name: plugin.name, message: `The plugin failed to load: ${err.message}` });
                this.logger?.error(`Plugin ${plugin.name}@${plugin.version} failed to load: ${err.stack ?? err.message}`);
            }
        }
        this.registerUiRoutes();
        PluginRegistry.setLoaded(this.registryEntries());
        await this.afterLoad?.(this.getClasses());
    }

    /** The loaded plugins as `PluginRegistry` entries, with the UI state of those that declare UI. */
    public registryEntries(): LoadedPluginWithUi[] {
        return this.loaded.map((plugin) => {
            const entry: LoadedPluginWithUi = { name: plugin.name, version: plugin.version };
            const ui = plugin.manifest?.ui;
            if (!ui || [ui.apps, ui.settingsSections, ui.adminNav, ui.appRail].every((list) => !list?.length)) {
                return entry;
            }
            const error: string | undefined = this.uiFailure(plugin);
            const mounts = this.uiMounts.get(plugin.name) ?? { mounts: [], refused: [] };
            entry.ui = error
                ? { status: "failed", error, mounts: [], nav: { settingsSections: [], adminNav: [], appRail: [] } }
                : {
                      status: "built",
                      mounts: mounts.mounts,
                      nav: manifestNav(plugin.manifest, [...(this.ui.refusedMounts?.get(plugin.name) ?? []), ...mounts.refused]),
                  };
            return entry;
        });
    }

    /** Why `plugin`'s UI isn't served, or `undefined` when it is. */
    private uiFailure(plugin: InstalledPlugin): string | undefined {
        const failure: string | undefined = this.ui.failed?.get(plugin.name);
        if (failure) {
            return failure;
        }
        if (!this.ui.hosts && (plugin.uiApps?.length ?? 0) > 0) {
            return "This server doesn't serve plugin UI.";
        }
        return undefined;
    }

    private registerUiRoutes(): void {
        // Every route registered so far: the server's own and the plugins' backend routes.
        const routes: RegisteredRoutePath[] = registeredRoutePaths(this.getClasses());
        for (const plugin of this.loaded) {
            const mounts = { mounts: [] as string[], refused: [] as string[] };
            this.uiMounts.set(plugin.name, mounts);
            if (!this.ui.hosts || this.uiFailure(plugin)) {
                continue;
            }
            for (const app of plugin.uiApps ?? []) {
                const collision: RegisteredRoutePath | undefined = findRouteCollision(app.mount, routes);
                if (collision) {
                    const message: string = `Its UI app ${app.id} isn't served: ${app.mount} clashes with the route ${collision.path} (${collision.name}).`;
                    this.errors.push({ name: plugin.name, message });
                    this.logger?.error(`Plugin ${plugin.name}: ${message}`);
                    mounts.refused.push(app.mount);
                    continue;
                }
                const name: string = pluginUiRouteName(pluginPackagePrefix(plugin.name), app.id);
                const clazz: any = createPluginUiRoute(this.ui.hosts[app.host], app, name);
                clazz.fqn = name;
                this.getClasses().set(name, clazz);
                // Later apps can't mount at or beneath this one.
                routes.push({ name, path: app.mount, react: false });
                mounts.mounts.push(app.mount);
                this.logger?.info(`Serving plugin ${plugin.name}'s ${app.host} pages at ${app.mount}.`);
            }
        }
    }
}
