///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import fs from "fs";
import os from "os";
import path from "path";
import zlib from "zlib";
import nconf from "nconf";
import { computePluginStateHash, PluginRegistry } from "@rapidmx/restapi";
import { PLUGIN_SAFE_MODE_ENV, PluginHost } from "../../src/plugins/PluginHost.js";
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
            [{ name: "@rapidmx/activesync" }, { name: "@rapidmx/mapi" }, { name: "@rapidmx/missing" }, { name: "@rapidmx/bad", version: "1.0.0" }],
            registry,
            {},
        );
        expect(rows.map((r) => r.name)).toEqual(["@rapidmx/mapi", "@rapidmx/activesync"]);
        expect(rows[1]).toEqual(
            expect.objectContaining({ packageVersion: "2.0.0", integrity: "sha512-x", enabled: true, removed: false, settings: { "mail:eas:sync_window_size": 100 } }),
        );
        expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/@rapidmx\/missing@latest was not found/));
        expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/@rapidmx\/bad: not a plugin/));
    });

    it("seeds a default from a local tarball source", async () => {
        const file = path.join(os.tmpdir(), `plugin-${Date.now()}.tgz`);
        tarball(file, { "README.md": "x".repeat(700), "package.json": JSON.stringify({ name: "@rapidmx/activesync", version: "3.0.0", rapidmx: { plugin: MANIFEST } }) });
        try {
            const store = new MemoryStore([]);
            const rows = await store.loadAndSeed([{ name: "@rapidmx/activesync" }], registry, { "@rapidmx/activesync": file });
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

    it("loads no plugins in safe mode", async () => {
        process.env[PLUGIN_SAFE_MODE_ENV] = "1";
        const store = new MemoryStore([row("@rapidmx/activesync")]);
        const installer: any = { install: vi.fn(async () => ({ installed: [], errors: [] })) };
        const host = await PluginHost.prepare({ config: configWith({}), logger, datastore: "sql", pluginClass: class {}, appRoot: process.cwd(), store, installer });
        expect(installer.install).toHaveBeenCalledWith([]);
        expect(host.safeMode).toBe(true);
        expect(host.loadedHash).toBe(computePluginStateHash([]));
    });

    it("still starts the server when the plugin table can't be read", async () => {
        const store: any = { loadAndSeed: vi.fn(async () => Promise.reject(new Error("db down"))) };
        const installer: any = { install: vi.fn(async () => ({ installed: [], errors: [] })) };
        const host = await PluginHost.prepare({ config: configWith({ system: { plugins: { defaults: [{ name: "x" }] } } }), logger, datastore: "mongo", pluginClass: class {}, appRoot: process.cwd(), store, installer });
        expect(host.classLoader).toBeDefined();
        expect(logger.error).toHaveBeenCalledWith(expect.stringMatching(/Could not read the plugin list/));
    });
});
