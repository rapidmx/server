///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import fs from "fs";
import os from "os";
import path from "path";
import zlib from "zlib";
import nconf from "nconf";
import { computePluginStateHash, PluginRegistry } from "@rapidmx/restapi";
import { installRetryDelayMs, PLUGIN_SAFE_MODE_ENV, PluginHost } from "../../src/plugins/PluginHost.js";
import { findAllPlugins, PluginStateStore, readTarballPackageJson } from "../../src/plugins/PluginStateStore.js";

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

    it("loads no plugins in safe mode", async () => {
        process.env[PLUGIN_SAFE_MODE_ENV] = "1";
        const store = new MemoryStore([row("@rapidmx/activesync")]);
        const installer: any = { install: vi.fn(async () => ({ installed: [], errors: [] })) };
        const host = await PluginHost.prepare({ config: configWith({}), logger, datastore: "sql", pluginClass: class {}, appRoot: process.cwd(), store, installer });
        expect(installer.install).toHaveBeenCalledWith([]);
        expect(host.safeMode).toBe(true);
        expect(host.loadedHash).toBe(computePluginStateHash([]));
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
            pExpire: vi.fn(async () => 1),
            hSet: vi.fn(async () => 1),
            hGetAll: vi.fn(async () => ({})),
            hDel: vi.fn(async () => 1),
        };
        const createRedisClient = vi.fn(() => client);
        let renewedDuringInstall = false;
        const installer: any = {
            install: vi.fn(async () => {
                renewedDuringInstall = client.pExpire.mock.calls.length > 0;
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

    it("closes the restart lock connection when stopped before the server started", async () => {
        const client: any = { connect: vi.fn(async () => undefined), quit: vi.fn(async () => undefined), get: vi.fn(async () => null) };
        const config = configWith({ datastores: { cache: { url: "redis://cache" } } });
        const installer: any = { install: vi.fn(async () => ({ installed: [], errors: [] })) };
        const host = await PluginHost.prepare({ config, logger, datastore: "mongo", pluginClass: class {}, appRoot: process.cwd(), store: new MemoryStore([]), installer, createRedisClient: () => client });
        await host.stop();
        expect(client.quit).toHaveBeenCalled();

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
    });
});
