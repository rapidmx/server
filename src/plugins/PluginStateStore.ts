///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import fs from "fs";
import zlib from "zlib";
import { ConnectionManager, ObjectFactory } from "@rapidrest/service-core";
import {
    defaultPluginSettings,
    NpmRegistryClient,
    parsePluginManifest,
    type Plugin,
    type PluginManifest,
} from "@rapidmx/restapi";

/** A plugin the server ships enabled by default (config `system:plugins:defaults`). */
export interface DefaultPlugin {
    name: string;
    /** An exact version or dist-tag; defaults to `latest`. */
    version?: string;
    /** Whether the plugin starts out enabled; defaults to `true`. Only applies when the plugin is first added - after
     * that, administrators turn it on and off in the admin console. */
    enabled?: boolean;
}

/** The repository operations this store needs - the subset the Mongo and TypeORM SQL repositories share. */
export interface PluginRepository {
    find(options?: any): any;
    save(entity: any): Promise<any>;
}

/** Every row in `repo`. The Mongo repository's `find()` returns a cursor rather than an array (TypeORM's SQL
 * repository returns a promise of one), so both shapes are handled. */
export async function findAllPlugins(repo: { find(options?: any): any }): Promise<Plugin[]> {
    const result: any = repo.find({});
    return typeof result?.toArray === "function" ? result.toArray() : await result;
}

/** Reads the `package.json` inside an npm package tarball (`.tgz`) without extracting it. */
export function readTarballPackageJson(file: string): any {
    const tar: Buffer = zlib.gunzipSync(fs.readFileSync(file));
    for (let offset = 0; offset + 512 <= tar.length; ) {
        const header: Buffer = tar.subarray(offset, offset + 512);
        const name: string = header.toString("utf8", 0, 100).replace(/\0.*$/s, "");
        if (!name) {
            break;
        }
        const size: number = parseInt(header.toString("utf8", 124, 136).replace(/\0.*$/s, "").trim() || "0", 8);
        const body: number = offset + 512;
        // npm packs everything under a single top-level directory (normally `package/`).
        if (/^[^/]+\/package\.json$/.test(name)) {
            return JSON.parse(tar.toString("utf8", body, body + size));
        }
        offset = body + Math.ceil(size / 512) * 512;
    }
    throw new Error(`${file} has no package.json.`);
}

/**
 * Reads the plugin table before the server itself starts - the plugin set decides which classes the server loads,
 * so it can't come from the server's own connections. Opens a short-lived connection to just the datastore the
 * `Plugin` model lives in, and seeds the server's default plugins into it.
 */
export class PluginStateStore {
    constructor(
        private readonly config: any,
        private readonly logger: any,
        private readonly datastore: string,
        private readonly pluginClass: any,
    ) {}

    /** Runs `work` against the plugin repository on a connection that's closed afterwards. */
    public async withRepository<R>(work: (repo: PluginRepository) => Promise<R>): Promise<R> {
        const objectFactory = new ObjectFactory(this.config, this.logger);
        try {
            const connectionManager: ConnectionManager = await objectFactory.newInstance(ConnectionManager, { name: "plugins" });
            const models = new Map<string, any>([[this.pluginClass.name, this.pluginClass]]);
            await connectionManager.connect({ [this.datastore]: this.config.get(`datastores:${this.datastore}`) }, models);
            try {
                const connection: any = connectionManager.connections.get(this.datastore);
                const repo: PluginRepository =
                    typeof connection.getMongoRepository === "function"
                        ? connection.getMongoRepository(this.pluginClass)
                        : connection.getRepository(this.pluginClass);
                return await work(repo);
            } finally {
                await connectionManager.disconnect();
            }
        } finally {
            await objectFactory.destroy();
        }
    }

    /**
     * Returns every plugin row, first adding any default plugin that has never had a row. A default an
     * administrator removed keeps its (removed) row, so it stays removed; a default added in a later release is
     * still seeded into an existing deployment.
     */
    public async loadAndSeed(
        defaults: DefaultPlugin[],
        registryFor: (packageName: string) => NpmRegistryClient,
        sources: Record<string, string>,
    ): Promise<Plugin[]> {
        return this.withRepository(async (repo) => {
            let rows: Plugin[] = await findAllPlugins(repo);
            const known: Set<string> = new Set(rows.map((row) => row.name));
            for (const plugin of defaults) {
                if (known.has(plugin.name)) {
                    continue;
                }
                try {
                    const seeded: any = await this.describeDefault(plugin, registryFor, sources);
                    await repo.save(new this.pluginClass(seeded));
                    known.add(plugin.name);
                    this.logger?.info(`Added default plugin ${plugin.name}@${seeded.packageVersion}.`);
                } catch (err: any) {
                    // Not fatal: it's retried at the next start.
                    this.logger?.warn(`Could not add default plugin ${plugin.name}: ${err.message}`);
                }
            }
            rows = await findAllPlugins(repo);
            return rows;
        });
    }

    private async describeDefault(
        plugin: DefaultPlugin,
        registryFor: (packageName: string) => NpmRegistryClient,
        sources: Record<string, string>,
    ): Promise<Partial<Plugin>> {
        let packageVersion: string;
        let integrity: string | undefined;
        let manifest: PluginManifest | string;
        if (sources[plugin.name]) {
            const pkg: any = readTarballPackageJson(sources[plugin.name]);
            packageVersion = pkg.version;
            manifest = parsePluginManifest(pkg);
        } else {
            const found = await registryFor(plugin.name).getVersion(plugin.name, plugin.version || "latest");
            if (!found) {
                throw new Error(`${plugin.name}@${plugin.version || "latest"} was not found in the plugin registry.`);
            }
            packageVersion = found.version;
            integrity = found.integrity;
            manifest = found.manifest;
        }
        if (typeof manifest === "string") {
            throw new Error(manifest);
        }
        return {
            name: plugin.name,
            packageVersion,
            integrity,
            enabled: plugin.enabled ?? true,
            removed: false,
            settings: defaultPluginSettings(manifest),
            manifest,
        };
    }
}
