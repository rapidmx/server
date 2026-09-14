///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ClassLoader } from "@rapidrest/core";
import { fileURLToPath } from "url";
import path from "path";
import type { InstalledPlugin } from "./PluginInstaller.js";

/** The class-name prefix a plugin's exports are registered under, e.g. `plugins.rapidmx_activesync`. */
export function pluginPackagePrefix(name: string): string {
    return `plugins.${name.replace(/^@/, "").replace(/[^A-Za-z0-9_]/g, "_")}`;
}

/**
 * The server's class loader plus its plugins: after the usual scan of the server's own base path, it imports
 * each installed plugin's datastore entry point and registers every export, so the server mounts the plugin's
 * routes, connects its models and starts its jobs exactly as it does its own.
 *
 * A plugin whose entry point fails to import is skipped and reported through `errors`, rather than stopping the
 * server from starting.
 */
export class PluginClassLoader extends ClassLoader {
    public readonly errors: { name: string; message: string }[] = [];

    /** The plugins whose entry points imported cleanly. */
    public readonly loaded: InstalledPlugin[] = [];

    constructor(
        rootDir: string,
        ignore: RegExp[] | undefined,
        private readonly plugins: InstalledPlugin[],
        private readonly logger?: any,
        /** Called when the plugins' entry points are about to be imported (not at all when there are none). */
        private readonly onPluginsLoaded?: () => void,
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
    }
}
