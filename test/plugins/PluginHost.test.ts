///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import fs from "fs";
import os from "os";
import path from "path";
import zlib from "zlib";
import nconf from "nconf";
import { computePluginStateHash, PluginRegistry } from "@rapidmx/restapi";
import { FolderSQL, PluginSQL } from "@rapidmx/restapi/sql";
import { ConnectionManager, ObjectFactory } from "@rapidrest/service-core";
import { installRetryDelayMs, PLUGIN_SAFE_MODE_ENV, PluginHost } from "../../src/plugins/PluginHost.js";
import { MONGO_PLUGIN_UI_HOSTS } from "../../src/plugins/hosts/mongo.js";
import { resolvePluginUiApps } from "../../src/plugins/PluginInstaller.js";
import { findAllPlugins, pluginRepository, PluginStateStore, readTarballPackageJson } from "../../src/plugins/PluginStateStore.js";
import { SAFE_MODE_ATTEMPT_ENV, SAFE_MODE_BASELINE_ENV } from "../../src/plugins/supervisor.js";

const MANIFEST = { apiVersion: 1, displayName: "EAS", settings: [{ key: "mail:eas:sync_window_size", label: "Window", type: "number", default: 100 }] };

function configWith(values: Record<string, any>) {
    const conf = new nconf.Provider();
    conf.use("memory");
    conf.defaults({ base_path: "./src/mongo", ...values });
    return conf;
}

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

function row(name: string, extra: Record<string, any> = {}) {
    return { uid: name, name, packageVersion: "1.0.0", enabled: true, settings: {}, manifest: MANIFEST, ...extra } as any;
}

/** A store whose repository is an in-memory array. */
class MemoryStore extends PluginStateStore {
    constructor(public rows: any[]) {
        super(undefined, logger, "mongo", class {
            constructor(fields: any) {
                Object.assign(this, fields);
            }
        });
    }

    public async withRepository<R>(work: (repo: any) => Promise<R>): Promise<R> {
        return work({ find: async () => [...this.rows], save: async (entity: any) => this.rows.push(entity) });
    }
}

/** Builds an npm-style `.tgz` holding `files` under `package/`. */
function tarball(file: string, files: Record<string, string>): void {
    const blocks: Buffer[] = [];
    for (const [name, content] of Object.entries(files)) {
        const body = Buffer.from(content);
        const header = Buffer.alloc(512);
        header.write(`package/${name}`, 0);
        header.write(body.length.toString(8).padStart(11, "0") + "\0", 124);
        blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
    }
    blocks.push(Buffer.alloc(1024));
    fs.writeFileSync(file, zlib.gzipSync(Buffer.concat(blocks)));
}

describe("PluginStateStore", () => {
    const registry: any = {
        getVersion: vi.fn(async (name: string, version: string) =>
            name === "@rapidmx/missing" ? undefined : { name, version: version === "latest" ? "2.0.0" : version, integrity: "sha512-x", manifest: name === "@rapidmx/bad" ? "not a plugin" : MANIFEST },
        ),
    };

    it("seeds defaults that have never had a row, leaving removed ones removed", async () => {
        const store = new MemoryStore([row("@rapidmx/mapi", { removed: true, enabled: false })]);
        const rows = await store.loadAndSeed(
            [
                { name: "@rapidmx/activesync" },
                { name: "@rapidmx/mapi" },
                { name: "@rapidmx/missing" },
                { name: "@rapidmx/bad", version: "1.0.0" },
                { name: "@rapidmx/off", enabled: false },
            ],
            () => registry,
            {},
        );
        expect(rows.map((r) => r.name)).toEqual(["@rapidmx/mapi", "@rapidmx/activesync", "@rapidmx/off"]);
        expect(rows[2]).toEqual(expect.objectContaining({ enabled: false, removed: false }));
        expect(rows[1]).toEqual(
            expect.objectContaining({ packageVersion: "2.0.0", integrity: "sha512-x", enabled: true, removed: false, settings: { "mail:eas:sync_window_size": 100 } }),
        );
        expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/@rapidmx\/missing@latest was not found/));
        expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/@rapidmx\/bad: not a plugin/));
    });

    it("seeds a default whose required plugins won't be enabled as disabled, whatever the order of the defaults", async () => {
        const requires: Record<string, Record<string, string>> = {
            "@rapidmx/needs-mapi": { "@rapidmx/mapi": "^1.0.0" },
            "@rapidmx/needs-needs-mapi": { "@rapidmx/needs-mapi": "*" },
            "@rapidmx/needs-base": { "@rapidmx/base": "^2.0.0" },
            "@rapidmx/needs-off": { "@rapidmx/off": "*" },
        };
        const planning: any = {
            getVersion: vi.fn(async (name: string) => ({ name, version: "2.0.0", integrity: "sha512-x", manifest: { ...MANIFEST, requires: requires[name] } })),
        };
        const warn = vi.spyOn(logger, "warn");
        const store = new MemoryStore([row("@rapidmx/mapi", { removed: true, enabled: false })]);
        const rows = await store.loadAndSeed(
            [
                { name: "@rapidmx/needs-needs-mapi" },
                { name: "@rapidmx/needs-mapi" },
                // Listed before the plugin it requires, which is added in the same start.
                { name: "@rapidmx/needs-base" },
                { name: "@rapidmx/base" },
                { name: "@rapidmx/off", enabled: false },
                { name: "@rapidmx/needs-off" },
            ],
            () => planning,
            {},
        );
        const enabled = Object.fromEntries(rows.map((r) => [r.name, r.enabled]));
        expect(enabled).toEqual({
            "@rapidmx/mapi": false,
            "@rapidmx/needs-needs-mapi": false,
            "@rapidmx/needs-mapi": false,
            "@rapidmx/needs-base": true,
            "@rapidmx/base": true,
            "@rapidmx/off": false,
            "@rapidmx/needs-off": false,
        });
        expect(warn).toHaveBeenCalledWith("Default plugin @rapidmx/needs-mapi is added disabled: It requires @rapidmx/mapi ^1.0.0, which isn't loaded.");
        expect(warn).toHaveBeenCalledWith(expect.stringMatching(/needs-needs-mapi is added disabled: It requires @rapidmx\/needs-mapi/));
    });

    it("leaves a default for a later start, rather than adding it disabled, when a default it requires couldn't be described", async () => {
        let registryDown = true;
        const requires: Record<string, Record<string, string>> = {
            "@rapidmx/autodiscover": { "@rapidmx/mapi": "*" },
            "@rapidmx/needs-autodiscover": { "@rapidmx/autodiscover": "*" },
            "@rapidmx/needs-gone": { "@rapidmx/gone": "*" },
        };
        const flaky: any = {
            getVersion: vi.fn(async (name: string) => {
                if (name === "@rapidmx/mapi" && registryDown) {
                    throw new Error("ETIMEDOUT");
                }
                return { name, version: "1.0.0", integrity: "sha512-x", manifest: { ...MANIFEST, requires: requires[name] } };
            }),
        };
        const defaults = ["@rapidmx/needs-autodiscover", "@rapidmx/autodiscover", "@rapidmx/mapi", "@rapidmx/needs-gone"].map((name) => ({ name }));
        const store = new MemoryStore([row("@rapidmx/gone", { removed: true, enabled: false })]);
        const first = await store.loadAndSeed(defaults, () => flaky, {});
        // Requiring a plugin an administrator removed is still added disabled.
        expect(Object.fromEntries(first.map((r) => [r.name, r.enabled]))).toEqual({ "@rapidmx/gone": false, "@rapidmx/needs-gone": false });

        registryDown = false;
        const second = await store.loadAndSeed(defaults, () => flaky, {});
        expect(Object.fromEntries(second.map((r) => [r.name, r.enabled]))).toEqual({
            "@rapidmx/gone": false,
            "@rapidmx/needs-gone": false,
            "@rapidmx/needs-autodiscover": true,
            "@rapidmx/autodiscover": true,
            "@rapidmx/mapi": true,
        });
    });

    it("seeds a default from a local tarball source", async () => {
        const file = path.join(os.tmpdir(), `plugin-${Date.now()}.tgz`);
        tarball(file, { "README.md": "x".repeat(700), "package.json": JSON.stringify({ name: "@rapidmx/activesync", version: "3.0.0", rapidmx: { plugin: MANIFEST } }) });
        try {
            const store = new MemoryStore([]);
            const rows = await store.loadAndSeed([{ name: "@rapidmx/activesync" }], () => registry, { "@rapidmx/activesync": file });
            expect(rows[0]).toEqual(expect.objectContaining({ packageVersion: "3.0.0", integrity: undefined }));
        } finally {
            fs.rmSync(file, { force: true });
        }
    });

    it("reads and seeds the plugin table of a SQL datastore", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-store-sql-"));
        try {
            const config = configWith({ datastores: { sql: { type: "better-sqlite3", host: "localhost", database: path.join(dir, "plugins.db"), synchronize: true } } });
            const sqlLogger = { ...logger, child: () => sqlLogger, log: vi.fn() };
            const store = new PluginStateStore(config, sqlLogger, "sql", PluginSQL);
            const rows = await store.loadAndSeed([{ name: "@rapidmx/activesync" }], () => registry, {});
            expect(rows).toEqual([expect.objectContaining({ name: "@rapidmx/activesync", packageVersion: "2.0.0", enabled: true })]);
            expect(logger.error).not.toHaveBeenCalled();
            // A second read finds the seeded row instead of adding it again.
            expect((await store.loadAndSeed([{ name: "@rapidmx/activesync" }], () => registry, {})).map((r) => r.name)).toEqual(["@rapidmx/activesync"]);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("leaves the server's SQL connection with every model after reading the plugin table", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-store-sql-server-"));
        const sqlLogger = { ...logger, child: () => sqlLogger, log: vi.fn() };
        const datastores = { sql: { type: "better-sqlite3", host: "localhost", database: path.join(dir, "server.db"), synchronize: true } };
        const config = configWith({ datastores });
        const objectFactory = new ObjectFactory(config, sqlLogger);
        try {
            const store = new PluginStateStore(config, sqlLogger, "sql", PluginSQL);
            await store.loadAndSeed([], () => registry, {});
            // What Server.start() does next, with every model class it found.
            const connectionManager: ConnectionManager = await objectFactory.newInstance(ConnectionManager, { name: "default" });
            await connectionManager.connect(config.get("datastores"), new Map<string, any>([[PluginSQL.name, PluginSQL], [FolderSQL.name, FolderSQL]]));
            try {
                const connection: any = connectionManager.connections.get("sql");
                expect(connection.hasMetadata(FolderSQL)).toBe(true);
                const tables = (await connection.query("select name from sqlite_master where type = 'table'")).map((t: any) => t.name);
                expect(tables).toEqual(expect.arrayContaining(["plugin_sql", "folder_sql"]));
                expect(PluginSQL.datasource).toBe("sql");
            } finally {
                await connectionManager.disconnect();
            }
        } finally {
            await objectFactory.destroy();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("gets the plugin repository by the connection's database type", () => {
        const repo = {};
        const sql = { options: { type: "postgres" }, getMongoRepository: () => { throw new Error("mongo only"); }, getRepository: () => repo };
        const mongo = { getRepository: () => repo };
        const typeormMongo = { options: { type: "mongodb" }, getMongoRepository: () => repo, getRepository: () => { throw new Error("sql only"); } };
        expect(pluginRepository(sql, PluginSQL)).toBe(repo);
        expect(pluginRepository(mongo, PluginSQL)).toBe(repo);
        expect(pluginRepository(typeormMongo, PluginSQL)).toBe(repo);
    });

    it("reads rows from both a Mongo cursor and a promised SQL result", async () => {
        const rows = [row("a")];
        expect(await findAllPlugins({ find: () => ({ toArray: async () => rows }) })).toEqual(rows);
        expect(await findAllPlugins({ find: async () => rows })).toEqual(rows);
    });

    it("rejects a tarball without a package.json", () => {
        const file = path.join(os.tmpdir(), `plugin-empty-${Date.now()}.tgz`);
        tarball(file, { "index.js": "" });
        try {
            expect(() => readTarballPackageJson(file)).toThrow(/has no package\.json/);
        } finally {
            fs.rmSync(file, { force: true });
        }
    });
});

describe("PluginHost", () => {
    afterEach(() => {
        delete process.env[PLUGIN_SAFE_MODE_ENV];
        delete process.env[SAFE_MODE_BASELINE_ENV];
        delete process.env[SAFE_MODE_ATTEMPT_ENV];
        PluginRegistry.setLoaded([]);
    });

    const installed = (name: string) => ({ name, version: "1.0.0", manifest: MANIFEST, entryUrl: "file:///nope.js" });

    it("installs enabled plugins, applies the settings of installed ones and records their errors", async () => {
        const rows = [
            row("@rapidmx/activesync", { settings: { "mail:eas:sync_window_size": 42 } }),
            row("@rapidmx/broken", { settings: { "mail:broken:key": 1 } }),
            row("@rapidmx/off", { enabled: false }),
            row("@rapidmx/gone", { removed: true }),
        ];
        const installer: any = {
            install: vi.fn(async () => ({ installed: [installed("@rapidmx/activesync")], errors: [{ name: "@rapidmx/broken", message: "boom" }] })),
        };
        const config = configWith({});
        const host = await PluginHost.prepare({ config, logger, datastore: "mongo", pluginClass: class {}, appRoot: process.cwd(), store: new MemoryStore(rows), installer });

        expect(installer.install).toHaveBeenCalledWith([
            { name: "@rapidmx/activesync", packageVersion: "1.0.0", integrity: undefined },
            { name: "@rapidmx/broken", packageVersion: "1.0.0", integrity: undefined },
        ]);
        expect(config.get("mail:eas:sync_window_size")).toBe(42);
        expect(config.get("mail:broken:key")).toBeUndefined();
        expect(PluginRegistry.isActive("@rapidmx/activesync")).toBe(true);
        expect(host.loadedHash).toBe(computePluginStateHash(rows));
        expect(host.safeMode).toBe(false);

        await host.start({ getInstance: () => undefined } as any, async () => undefined);
        // No entry point was actually imported, so nothing counts as loaded once the server has started.
        expect(PluginRegistry.list()).toEqual([]);
        await host.stop();
    });

    it("loads required plugins first, and skips plugins whose requirements didn't load, cascading", async () => {
        const requiring = (name: string, requires: Record<string, string>, version = "1.0.0") => ({
            ...installed(name),
            version,
            manifest: { ...MANIFEST, displayName: name, requires },
        });
        const rows = ["autodiscover", "mapi", "activesync", "needs-mapi2", "needs-needs-mapi2", "needs-broken"].map((name) => row(name));
        const installer: any = {
            install: vi.fn(async () => ({
                installed: [
                    requiring("autodiscover", { activesync: "^1.0.0", mapi: "^1.0.0" }),
                    requiring("mapi", { activesync: "^1.0.0" }),
                    installed("activesync"),
                    requiring("needs-mapi2", { mapi: "^2.0.0" }),
                    requiring("needs-needs-mapi2", { "needs-mapi2": "*" }),
                    requiring("needs-broken", { broken: "*" }),
                ],
                errors: [{ name: "broken", message: "boom" }],
            })),
        };
        const host = await PluginHost.prepare({ config: configWith({}), logger, datastore: "mongo", pluginClass: class {}, appRoot: process.cwd(), store: new MemoryStore(rows), installer });

        expect((host.classLoader as any).plugins.map((plugin: any) => plugin.name)).toEqual(["activesync", "mapi", "autodiscover"]);
        expect(PluginRegistry.list().map((plugin) => plugin.name)).toEqual(["activesync", "mapi", "autodiscover"]);
        expect((host as any).errors).toEqual([
            { name: "broken", message: "boom" },
            { name: "needs-mapi2", message: "It requires mapi ^2.0.0, but 1.0.0 is loaded." },
            { name: "needs-broken", message: "It requires broken *, which isn't loaded." },
            { name: "needs-needs-mapi2", message: "It requires needs-mapi2 *, which isn't loaded." },
        ]);
        expect(logger.error).toHaveBeenCalledWith("Plugin needs-needs-mapi2 was not loaded: It requires needs-mapi2 *, which isn't loaded.");
    });

    it("reads a default plugin from its namespace's own registry, and everything else from the default registry", async () => {
        const requested: string[] = [];
        const store: any = {
            loadAndSeed: vi.fn(async (defaults: any[], registryFor: (name: string) => any) => {
                for (const plugin of defaults) {
                    const client = registryFor(plugin.name);
                    requested.push(`${plugin.name} -> ${client.registryUrl} ${client.authToken ?? "-"}`);
                }
                return [];
            }),
        };
        const installer: any = { install: vi.fn(async () => ({ installed: [], errors: [] })) };
        const config = configWith({
            system: {
                plugins: {
                    registry: "https://registry.default.test",
                    namespaces: ["@rapidmx", { name: "@acme", registry: "https://npm.acme.test", token: "secret" }],
                    defaults: [{ name: "@acme/crm-plugin" }, { name: "@rapidmx/mapi-plugin" }],
                },
            },
        });
        await PluginHost.prepare({ config, logger, datastore: "mongo", pluginClass: class {}, appRoot: process.cwd(), store, installer });
        expect(requested).toEqual(["@acme/crm-plugin -> https://npm.acme.test secret", "@rapidmx/mapi-plugin -> https://registry.default.test -"]);
    });

    it("loads no plugins in safe mode, leaving installed ones in place, and tries them again with a backoff", async () => {
        process.env[PLUGIN_SAFE_MODE_ENV] = "1";
        process.env[SAFE_MODE_BASELINE_ENV] = "failed-hash";
        const store = new MemoryStore([row("@rapidmx/activesync")]);
        const installer: any = { install: vi.fn(async () => ({ installed: [], errors: [] })) };
        const host = await PluginHost.prepare({ config: configWith({}), logger, datastore: "sql", pluginClass: class {}, appRoot: process.cwd(), store, installer });
        expect(installer.install).not.toHaveBeenCalled();
        expect(host.safeMode).toBe(true);
        expect(host.loadedHash).toBe(computePluginStateHash([]));
        expect(host.retry).toEqual({ safeModeBaseline: "failed-hash", safeModeRetryMs: 300_000 });

        process.env[SAFE_MODE_ATTEMPT_ENV] = "3";
        const config = configWith({ system: { plugins: { restart: { safe_mode_retry_ms: 1_000, safe_mode_retry_max_ms: 3_000 } } } });
        const third = await PluginHost.prepare({ config, logger, datastore: "sql", pluginClass: class {}, appRoot: process.cwd(), store, installer });
        expect(third.retry.safeModeRetryMs).toBe(3_000);
        process.env[SAFE_MODE_ATTEMPT_ENV] = "4";
        expect((await PluginHost.prepare({ config: configWith({}), logger, datastore: "sql", pluginClass: class {}, appRoot: process.cwd(), store, installer })).retry.safeModeRetryMs).toBe(
            2_400_000,
        );
    });

    it("backs off retrying failed installs, doubling up to a cap", () => {
        expect([1, 2, 3, 4, 5, 50].map((failures) => installRetryDelayMs(failures))).toEqual([60_000, 120_000, 240_000, 480_000, 600_000, 600_000]);
        expect(installRetryDelayMs(3, 1_000, 3_000)).toBe(3_000);
    });

    it("schedules a retry when npm failed to install, but not when plugins merely failed their checks", async () => {
        const failing: any = { install: vi.fn(async () => ({ installed: [], errors: [{ name: "@rapidmx/activesync", message: "ETIMEDOUT" }], installFailures: 2 })) };
        const config = configWith({ system: { plugins: { restart: { install_retry_ms: 10_000 } } } });
        const retried = await PluginHost.prepare({ config, logger, datastore: "mongo", pluginClass: class {}, appRoot: process.cwd(), store: new MemoryStore([row("@rapidmx/activesync")]), installer: failing });
        expect(retried.retryDelayMs).toBe(20_000);

        const checked: any = { install: vi.fn(async () => ({ installed: [], errors: [{ name: "@rapidmx/activesync", message: "integrity" }] })) };
        const notRetried = await PluginHost.prepare({ config, logger, datastore: "mongo", pluginClass: class {}, appRoot: process.cwd(), store: new MemoryStore([row("@rapidmx/activesync")]), installer: checked });
        expect(notRetried.retryDelayMs).toBeUndefined();
        expect(retried.retry.haltRollout).toBe(true);
        expect(notRetried.retry.haltRollout).toBe(false);
    });

    it("stops retrying failed installs after the most attempts, or on an error retrying won't fix, and reports it", async () => {
        const failing = (installFailures: number, installFailurePermanent = false): any => ({
            install: vi.fn(async () => ({ installed: [], errors: [{ name: "@rapidmx/activesync", message: "npm failed" }], installFailures, installFailurePermanent })),
        });
        const prepare = (installer: any) =>
            PluginHost.prepare({ config: configWith({}), logger, datastore: "mongo", pluginClass: class {}, appRoot: process.cwd(), store: new MemoryStore([row("@rapidmx/activesync")]), installer });

        expect((await prepare(failing(5))).retryDelayMs).toBe(600_000);
        for (const host of [await prepare(failing(6)), await prepare(failing(1, true))]) {
            expect(host.retryDelayMs).toBeUndefined();
            expect(host.retry.haltRollout).toBe(true);
            expect((host as any).errors).toContainEqual({ name: "*", message: expect.stringMatching(/won't be retried automatically/) });
        }
    });

    it("keeps renewing a restart lock it inherited from startup, and hands it to the watcher to release once serving", async () => {
        const values = new Map<string, string>([["plugins:restart-lock", "pod-a"]]);
        const client: any = {
            connect: vi.fn(async () => undefined),
            quit: vi.fn(async () => undefined),
            on: vi.fn(),
            set: vi.fn(async () => null),
            get: vi.fn(async (key: string) => values.get(key) ?? null),
            del: vi.fn(async (key: string) => (values.delete(key) ? 1 : 0)),
            eval: vi.fn(async (script: string, { keys: [key], arguments: [value] }: any) => {
                if (values.get(key) !== value) {
                    return 0;
                }
                if (/DEL/.test(script)) {
                    values.delete(key);
                }
                return 1;
            }),
            hSet: vi.fn(async () => 1),
            hGetAll: vi.fn(async () => ({})),
            hDel: vi.fn(async () => 1),
        };
        const createRedisClient = vi.fn(() => client);
        let renewedDuringInstall = false;
        const installer: any = {
            install: vi.fn(async () => {
                renewedDuringInstall = client.eval.mock.calls.some(([script]: string[]) => /PEXPIRE/.test(script));
                return { installed: [], errors: [] };
            }),
        };
        const config = configWith({
            datastores: { cache: { url: "redis://cache" } },
            system: { plugins: { instance_id: "pod-a", restart: { lock_release_delay_ms: 0 } } },
        });
        const host = await PluginHost.prepare({ config, logger, datastore: "mongo", pluginClass: class {}, appRoot: process.cwd(), store: new MemoryStore([]), installer, createRedisClient });
        expect(renewedDuringInstall).toBe(true);
        expect(values.get("plugins:restart-lock")).toBe("pod-a");

        await host.start({ getInstance: () => undefined } as any, async () => undefined);
        expect(createRedisClient).toHaveBeenCalledTimes(1);
        expect(values.has("plugins:restart-lock")).toBe(false);
        await host.stop();
        expect(client.quit).toHaveBeenCalled();
    });

    it("closes the restart lock connection when stopped before the server started, giving the lock back on shutdown", async () => {
        const client: any = {
            connect: vi.fn(async () => undefined),
            quit: vi.fn(async () => undefined),
            get: vi.fn(async () => null),
            eval: vi.fn(async () => 1),
        };
        const config = configWith({ datastores: { cache: { url: "redis://cache" } } });
        const installer: any = { install: vi.fn(async () => ({ installed: [], errors: [] })) };
        const host = await PluginHost.prepare({ config, logger, datastore: "mongo", pluginClass: class {}, appRoot: process.cwd(), store: new MemoryStore([]), installer, createRedisClient: () => client });
        await host.stop({ shutdown: true });
        expect(client.quit).toHaveBeenCalledTimes(1);
        expect(client.eval).toHaveBeenCalledWith(expect.stringContaining("DEL"), expect.objectContaining({ keys: ["plugins:restart-lock"] }));
        await host.stop();
        expect(client.quit).toHaveBeenCalledTimes(1);

        const warn = vi.spyOn(logger, "warn");
        const down: any = { connect: vi.fn(async () => Promise.reject(new Error("refused"))), quit: vi.fn(async () => undefined) };
        await PluginHost.prepare({ config, logger, datastore: "mongo", pluginClass: class {}, appRoot: process.cwd(), store: new MemoryStore([]), installer, createRedisClient: () => down });
        expect(warn).toHaveBeenCalledWith(expect.stringMatching(/status reporting is unavailable: refused/));
        expect(down.quit).toHaveBeenCalled();
    });

    it("still starts the server when the plugin table can't be read", async () => {
        const store: any = { loadAndSeed: vi.fn(async () => Promise.reject(new Error("db down"))) };
        const installer: any = { install: vi.fn(async () => ({ installed: [], errors: [] })) };
        const host = await PluginHost.prepare({ config: configWith({ system: { plugins: { defaults: [{ name: "x" }] } } }), logger, datastore: "mongo", pluginClass: class {}, appRoot: process.cwd(), store, installer });
        expect(host.classLoader).toBeDefined();
        expect(logger.error).toHaveBeenCalledWith(expect.stringMatching(/Could not read the plugin list/));
        // An unreadable list isn't an empty one: installed plugins are left alone.
        expect(installer.install).not.toHaveBeenCalled();
    });

    describe("plugin UI", () => {
        const uiPlugin = (name: string, apps: { id: string; host: string; mount: string }[]) => {
            const manifest: any = { ...MANIFEST, displayName: name, ui: { apps: apps.map((app) => ({ ...app, dir: `apps/${app.id}` })) } };
            const packageDir = path.join(process.cwd(), "plugins", "node_modules", name);
            return { ...installed(name), manifest, packageDir, uiApps: resolvePluginUiApps(packageDir, manifest) };
        };
        const prepare = (overrides: Record<string, any>) =>
            PluginHost.prepare({
                config: configWith({}),
                logger,
                datastore: "mongo",
                pluginClass: class {},
                appRoot: process.cwd(),
                store: new MemoryStore([row("first"), row("second"), row("backend")]),
                uiHosts: MONGO_PLUGIN_UI_HOSTS,
                ...overrides,
            });

        it("builds plugins' UI before the server starts, leaving out apps that overlap an earlier plugin's, and serves the build", async () => {
            const first = uiPlugin("first", [{ id: "book", host: "public", mount: "/book" }]);
            const second = uiPlugin("second", [
                { id: "book", host: "public", mount: "/book" },
                { id: "other", host: "www", mount: "/settings/other" },
            ]);
            const installer: any = { install: vi.fn(async () => ({ installed: [first, second, installed("backend")], errors: [] })) };
            const uiBuilder = { build: vi.fn(async () => ({ manifestPath: "/app/plugins/.ui-build/abc/.vite/manifest.json", hash: "abc", built: ["first", "second"], failed: [] })) };
            const config = configWith({ react: { manifestPath: "dist/public/.vite/manifest.json" } });
            const host = await prepare({ config, installer, uiBuilder });

            const [plugins] = (uiBuilder.build.mock.calls as any[])[0];
            expect(plugins.map((plugin: any) => plugin.name)).toEqual(["first", "second", "backend"]);
            expect(plugins[1].uiApps.map((app: any) => app.mount)).toEqual(["/settings/other"]);
            expect(config.get("react:manifestPath")).toBe("/app/plugins/.ui-build/abc/.vite/manifest.json");
            const ui = (host.classLoader as any).ui;
            expect(ui.hosts).toBe(MONGO_PLUGIN_UI_HOSTS);
            expect(ui.refusedMounts).toEqual(new Map([["second", ["/book"]]]));
            expect((host as any).errors).toEqual([{ name: "second", message: expect.stringMatching(/^Its UI app at \/book isn't served: /) }]);
        });

        it("records plugins whose UI didn't build, keeping the prebuilt bundles, and never fails the start when building throws", async () => {
            const one = uiPlugin("first", [{ id: "one", host: "www", mount: "/one" }]);
            const installer: any = { install: vi.fn(async () => ({ installed: [one, installed("backend")], errors: [] })) };
            const config = configWith({ react: { manifestPath: "dist/public/.vite/manifest.json" } });
            const failing = { build: vi.fn(async () => ({ built: [], failed: [{ name: "first", message: "The plugin's UI failed to build: boom" }] })) };
            const host = await prepare({ config, installer, uiBuilder: failing });
            expect(config.get("react:manifestPath")).toBe("dist/public/.vite/manifest.json");
            expect((host.classLoader as any).ui.failed).toEqual(new Map([["first", "The plugin's UI failed to build: boom"]]));
            expect((host as any).errors).toEqual([{ name: "first", message: "The plugin's UI failed to build: boom" }]);

            const throwing = { build: vi.fn(async () => Promise.reject(new Error("vite is missing"))) };
            const thrown = await prepare({ installer, uiBuilder: throwing });
            expect((thrown.classLoader as any).ui.failed).toEqual(new Map([["first", "The plugin's UI wasn't built: vite is missing"]]));
            expect(logger.error).toHaveBeenCalledWith(expect.stringMatching(/Plugin UI wasn't built/));
        });

        it("warns when react:manifestPath is pinned by the environment, so the build can't be served", async () => {
            const installer: any = { install: vi.fn(async () => ({ installed: [uiPlugin("first", [{ id: "one", host: "www", mount: "/one" }])], errors: [] })) };
            // A read-only store ahead of the writable one, as nconf's env and argv stores are.
            const config = new nconf.Provider();
            config.add("pinned", { type: "literal", store: { react: { manifestPath: "pinned.json" } } });
            config.use("memory");
            config.defaults({ base_path: "./src/mongo" });
            const warn = vi.spyOn(logger, "warn");
            await prepare({ config, installer, uiBuilder: { build: vi.fn(async () => ({ manifestPath: "built.json", built: ["first"], failed: [] })) } });
            expect(config.get("react:manifestPath")).toBe("pinned.json");
            expect(warn).toHaveBeenCalledWith(expect.stringMatching(/isn't served/));
        });

        it("builds nothing in safe mode, without host routes, or when the plugin list can't be read", async () => {
            const installer: any = { install: vi.fn(async () => ({ installed: [uiPlugin("first", [{ id: "one", host: "www", mount: "/one" }])], errors: [] })) };
            const uiBuilder = { build: vi.fn() };
            await prepare({ installer, uiBuilder, uiHosts: undefined });
            await prepare({ installer, uiBuilder, store: { loadAndSeed: vi.fn(async () => Promise.reject(new Error("db down"))) } });
            process.env[PLUGIN_SAFE_MODE_ENV] = "1";
            await prepare({ installer, uiBuilder });
            expect(uiBuilder.build).not.toHaveBeenCalled();
        });

        it("reports each loaded plugin's UI state in its status", async () => {
            const one = { ...uiPlugin("first", [{ id: "one", host: "www", mount: "/one" }]), entryUrl: "file:///nope.js" };
            const installer: any = { install: vi.fn(async () => ({ installed: [one], errors: [] })) };
            const host = await prepare({ installer, uiBuilder: { build: vi.fn(async () => ({ built: [], failed: [{ name: "first", message: "boom" }] })) } });
            // As if the entry point had imported.
            host.classLoader.loaded.push(one);
            await host.start({ getInstance: () => undefined } as any, async () => undefined);
            expect((host as any).watcher.options.status.loaded).toEqual([{ name: "first", version: "1.0.0", ui: { status: "failed", mounts: [], error: "boom" } }]);
            expect(PluginRegistry.list()).toEqual([expect.objectContaining({ name: "first", ui: expect.objectContaining({ status: "failed" }) })]);
            await host.stop();
        });
    });
});
