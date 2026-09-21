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
    pruneUnmetRequirements,
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

/** The plugin repository on `connection`. Every TypeORM DataSource has getMongoRepository(), which throws on any other
 * database, so this goes by the connection's type (service-core's own Mongo connection has no `options` and serves
 * getRepository()). */
export function pluginRepository(connection: any, pluginClass: any): PluginRepository {
    return connection.options?.type === "mongodb" ? connection.getMongoRepository(pluginClass) : connection.getRepository(pluginClass);
}

/**
 * Empties the saved settings of the plugin row `uid` - only while the row is still removed, so a plugin added again in
 * the meantime keeps its settings. This is the "state" half of deleting an uninstalled plugin's data: the row itself
 * stays, since it is what stops the server's default plugin list adding a removed plugin again.
 */
export async function clearRemovedPluginSettings(connection: any, pluginClass: any, uid: string): Promise<void> {
    const repo: any = pluginRepository(connection, pluginClass);
    if (connection.options?.type && connection.options.type !== "mongodb") {
        await repo.update({ uid, removed: true }, { settings: {} });
    } else {
        await (repo.collection ?? repo).updateOne({ uid, removed: true }, { $set: { settings: {} } });
    }
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
        // service-core keeps each SQL DataSource for the life of the process by datastore name, and a later connect under
        // that name reuses it with the entities it was first given. Connecting as the server's own datastore (`sql`) here
        // left the server's connection with only the Plugin model: no other tables were created and every other model's
        // query failed with "No metadata". So this connection gets a name of its own, and the Plugin model is named as
        // its entity (its @DataStore is the server's name), on a copy of the datastore config.
        const name: string = `${this.datastore}-plugin-state`;
        const datasource: any = { ...this.config.get(`datastores:${this.datastore}`), entities: [this.pluginClass.name] };
        // The connection manager records the datastore a model was connected on; the server's own connect sets it again.
        const previousDatasource: any = this.pluginClass.datasource;
        try {
            const connectionManager: ConnectionManager = await objectFactory.newInstance(ConnectionManager, { name: "plugins" });
            const models = new Map<string, any>([[this.pluginClass.name, this.pluginClass]]);
            await connectionManager.connect({ [name]: datasource }, models);
            try {
                return await work(pluginRepository(connectionManager.connections.get(name), this.pluginClass));
            } finally {
                await connectionManager.disconnect();
            }
        } finally {
            this.pluginClass.datasource = previousDatasource;
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
            let seeds: Partial<Plugin>[] = [];
            const failed: Set<string> = new Set();
            for (const plugin of defaults) {
                if (known.has(plugin.name)) {
                    continue;
                }
                try {
                    seeds.push(await this.describeDefault(plugin, registryFor, sources));
                    known.add(plugin.name);
                } catch (err: any) {
                    // Not fatal: it's retried at the next start.
                    failed.add(plugin.name);
                    this.logger?.warn(`Could not add default plugin ${plugin.name}: ${err.message}`);
                }
            }

            // A default requiring a default that couldn't be described this time (say, the registry was briefly unreachable)
            // is left for the next start too, rather than added disabled below for good - and so is anything requiring it.
            for (let deferred: boolean = true; deferred; ) {
                deferred = false;
                seeds = seeds.filter((seed) => {
                    const waitingOn: string | undefined = Object.keys(seed.manifest?.requires ?? {}).find((name) => failed.has(name));
                    if (waitingOn) {
                        failed.add(seed.name!);
                        deferred = true;
                        this.logger?.warn(`Default plugin ${seed.name} is added at a later start: it requires ${waitingOn}, which couldn't be added this time.`);
                    }
                    return !waitingOn;
                });
            }

            // A default whose required plugins won't all be enabled, in range, would be skipped at every start - for example
            // one requiring a plugin an administrator removed. It's added disabled instead. Checked across the existing rows
            // and every default being added together, so the order of the defaults doesn't matter.
            const { dropped } = pruneUnmetRequirements(
                [...rows.filter((row) => row.enabled && !row.removed), ...seeds.filter((seed) => seed.enabled)].map((plugin) => ({
                    name: plugin.name!,
                    version: plugin.packageVersion!,
                    manifest: plugin.manifest,
                })),
            );
            const unmet: Map<string, string> = new Map(dropped.map((plugin) => [plugin.name, plugin.message]));

            for (const seeded of seeds) {
                if (seeded.enabled && unmet.has(seeded.name!)) {
                    seeded.enabled = false;
                    this.logger?.warn(`Default plugin ${seeded.name} is added disabled: ${unmet.get(seeded.name!)}`);
                }
                try {
                    await repo.save(new this.pluginClass(seeded));
                    this.logger?.info(`Added default plugin ${seeded.name}@${seeded.packageVersion}.`);
                } catch (err: any) {
                    this.logger?.warn(`Could not add default plugin ${seeded.name}: ${err.message}`);
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
