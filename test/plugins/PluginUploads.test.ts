///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import crypto from "crypto";
import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import zlib from "zlib";
import nconf from "nconf";
import * as uuid from "uuid";
import { computePluginStateHash, LocalFsBlobStore, packIntegrity, PLUGIN_UPLOAD_BLOB_PREFIX, pluginUploadBlobKey, PluginRegistry } from "@rapidmx/restapi";
import { PLUGIN_SAFE_MODE_ENV, PluginHost } from "../../src/plugins/PluginHost.js";
import { PluginInstaller } from "../../src/plugins/PluginInstaller.js";
import { PluginStateStore } from "../../src/plugins/PluginStateStore.js";
import { openConfiguredBlobStore, prepareUploadedPlugins, UPLOAD_CACHE_DIR } from "../../src/plugins/PluginUploads.js";

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const MANIFEST = { apiVersion: 1, displayName: "Uploaded" };

/** An `npm pack`-style tgz of `files` under `package/` (ustar headers with checksums). */
function pack(files: Record<string, string | object>): Buffer {
    const blocks: Buffer[] = [];
    for (const [name, content] of Object.entries(files)) {
        const body = Buffer.from(typeof content === "string" ? content : JSON.stringify(content));
        const header = Buffer.alloc(512);
        header.write(`package/${name}`, 0);
        header.write("0000644\0", 100);
        header.write(body.length.toString(8).padStart(11, "0") + "\0", 124);
        header.write("        ", 148);
        header.write("0", 156);
        header.write("ustar\0" + "00", 257);
        header.write(header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0") + "\0 ", 148);
        blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
    }
    blocks.push(Buffer.alloc(1024));
    return zlib.gzipSync(Buffer.concat(blocks));
}

/** A plugin pack: `package.json` with the plugin manifest and a `./mongo` and `./sql` entry point. */
function plugin(name: string, version: string, extra: Record<string, any> = {}): Buffer {
    return pack({
        "package.json": { name, version, rapidmx: { plugin: MANIFEST }, exports: { "./mongo": "./index.js", "./sql": "./index.js" }, ...extra },
        "index.js": "export class Thing {}\n",
    });
}

/** The plugin row an upload of `bytes` makes. */
function uploadRow(name: string, version: string, bytes: Buffer, extra: Record<string, any> = {}): any {
    return {
        uid: name,
        name,
        packageVersion: version,
        enabled: true,
        settings: {},
        source: "upload",
        uploadBlobKey: pluginUploadBlobKey(bytes),
        uploadFilename: "x.tgz",
        integrity: packIntegrity(bytes),
        ...extra,
    };
}

/** A blob store holding `blobs` by key. */
function blobStore(blobs: Record<string, Buffer>) {
    return {
        get: vi.fn(async (key: string) => {
            if (!blobs[key]) {
                throw new Error(`No blob exists at key '${key}'.`);
            }
            return blobs[key];
        }),
    };
}

function configWith(values: Record<string, any>) {
    const conf = new nconf.Provider();
    conf.use("memory");
    conf.defaults({ base_path: "./src/mongo" });
    for (const [key, value] of Object.entries(values)) {
        conf.set(key, value);
    }
    return conf;
}

class MemoryStore extends PluginStateStore {
    constructor(public rows: any[]) {
        super(undefined, logger, "mongo", class {});
    }

    public async withRepository<R>(work: (repo: any) => Promise<R>): Promise<R> {
        return work({ find: async () => [...this.rows], save: async (entity: any) => this.rows.push(entity) });
    }
}

const windows: boolean = process.platform === "win32";
const npmAvailable: boolean = spawnSync(windows ? "npm.cmd" : "npm", ["--version"], { shell: windows }).status === 0;
const sha256 = (bytes: Buffer): string => crypto.createHash("sha256").update(bytes).digest("hex");

describe("uploaded plugin packs", () => {
    let dir: string;

    beforeEach(() => {
        // Inside the server's directory, as in production, so shared peers resolve to the server's own copies.
        dir = path.join(process.cwd(), `tmp-plugins-${uuid.v4()}`);
        vi.clearAllMocks();
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
        delete process.env[PLUGIN_SAFE_MODE_ENV];
        PluginRegistry.setLoaded([]);
    });

    const prepare = (rows: any[], blobs: ReturnType<typeof blobStore>, extra: Record<string, any> = {}) =>
        prepareUploadedPlugins(rows, { config: configWith({}), logger, pluginsDir: dir, blobStore: blobs, ...extra });

    describe("prepareUploadedPlugins", () => {
        it("fetches a pack by the row's blob key, verifies it and caches it at <dir>/uploads/<sha256>.tgz (0600)", async () => {
            const bytes = plugin("@acme/one", "1.2.3");
            const blobs = blobStore({ [pluginUploadBlobKey(bytes)]: bytes });
            const { desired, errors } = await prepare([uploadRow("@acme/one", "1.2.3", bytes)], blobs);

            expect(errors).toEqual([]);
            const file = path.join(dir, UPLOAD_CACHE_DIR, `${sha256(bytes)}.tgz`);
            expect(desired.get("@acme/one")).toEqual({ name: "@acme/one", packageVersion: "1.2.3", integrity: packIntegrity(bytes), pack: file });
            expect(fs.readFileSync(file).equals(bytes)).toBe(true);
            if (!windows) {
                expect(fs.statSync(file).mode & 0o777).toBe(0o600);
            }
            expect(fs.readdirSync(path.join(dir, UPLOAD_CACHE_DIR))).toEqual([path.basename(file)]);
        });

        it("reuses a verified cached pack without touching the blob store, and refetches one that doesn't match", async () => {
            const bytes = plugin("@acme/one", "1.2.3");
            const blobs = blobStore({ [pluginUploadBlobKey(bytes)]: bytes });
            const rows = [uploadRow("@acme/one", "1.2.3", bytes)];
            const file = (await prepare(rows, blobs)).desired.get("@acme/one")!.pack!;
            expect(blobs.get).toHaveBeenCalledTimes(1);

            expect((await prepare(rows, blobs)).errors).toEqual([]);
            expect(blobs.get).toHaveBeenCalledTimes(1);

            fs.writeFileSync(file, "corrupt");
            expect((await prepare(rows, blobs)).errors).toEqual([]);
            expect(blobs.get).toHaveBeenCalledTimes(2);
            expect(fs.readFileSync(file).equals(bytes)).toBe(true);
        });

        it("serves a pod that can't reach the blob store from its cache", async () => {
            const bytes = plugin("@acme/one", "1.2.3");
            const rows = [uploadRow("@acme/one", "1.2.3", bytes)];
            await prepare(rows, blobStore({ [pluginUploadBlobKey(bytes)]: bytes }));
            const unreachable = { get: vi.fn(async () => Promise.reject(new Error("connect ETIMEDOUT"))) };
            expect((await prepare(rows, unreachable)).desired.has("@acme/one")).toBe(true);
            expect(unreachable.get).not.toHaveBeenCalled();
        });

        it("skips a missing blob with an error and still prepares the others", async () => {
            const one = plugin("@acme/one", "1.0.0");
            const two = plugin("@acme/two", "2.0.0");
            const { desired, errors } = await prepare([uploadRow("@acme/one", "1.0.0", one), uploadRow("@acme/two", "2.0.0", two)], blobStore({ [pluginUploadBlobKey(two)]: two }));

            expect([...desired.keys()]).toEqual(["@acme/two"]);
            expect(errors).toEqual([{ name: "@acme/one", message: expect.stringMatching(/couldn't be read from the blob store: No blob exists/) }]);
            expect(logger.error).toHaveBeenCalledWith(expect.stringMatching(/Plugin @acme\/one was not loaded/));
        });

        it("skips a pack whose bytes don't match the recorded integrity or blob key", async () => {
            const bytes = plugin("@acme/one", "1.0.0");
            const other = plugin("@acme/one", "1.0.0", { description: "different" });
            const key = pluginUploadBlobKey(bytes);

            const wrongBlob = await prepare([uploadRow("@acme/one", "1.0.0", bytes)], blobStore({ [key]: other }));
            expect(wrongBlob.desired.size).toBe(0);
            expect(wrongBlob.errors[0].message).toMatch(/isn't the one that was recorded/);

            const wrongIntegrity = await prepare([uploadRow("@acme/one", "1.0.0", bytes, { integrity: packIntegrity(other) })], blobStore({ [key]: bytes }));
            expect(wrongIntegrity.desired.size).toBe(0);
            expect(wrongIntegrity.errors[0].message).toMatch(/isn't the one that was recorded/);

            const none = await prepare([uploadRow("@acme/one", "1.0.0", bytes, { integrity: undefined })], blobStore({ [key]: bytes }));
            expect(none.errors[0].message).toMatch(/No integrity hash was recorded/);
            expect(fs.existsSync(path.join(dir, UPLOAD_CACHE_DIR)) ? fs.readdirSync(path.join(dir, UPLOAD_CACHE_DIR)) : []).toEqual([]);
        });

        it("skips every upload when uploads are turned off", async () => {
            const bytes = plugin("@acme/one", "1.0.0");
            const blobs = blobStore({ [pluginUploadBlobKey(bytes)]: bytes });
            const { desired, errors } = await prepare([uploadRow("@acme/one", "1.0.0", bytes)], blobs, { config: configWith({ "system:plugins:uploads:enabled": false }) });

            expect(desired.size).toBe(0);
            expect(errors).toEqual([{ name: "@acme/one", message: expect.stringMatching(/system:plugins:uploads:enabled/) }]);
            expect(blobs.get).not.toHaveBeenCalled();
            expect(logger.error).toHaveBeenCalled();
        });

        it("skips a pack whose package.json name or version isn't the row's", async () => {
            const bytes = plugin("@acme/other", "1.0.0");
            const blobs = blobStore({ [pluginUploadBlobKey(bytes)]: bytes });
            const wrongName = await prepare([uploadRow("@acme/one", "1.0.0", bytes)], blobs);
            expect(wrongName.errors[0].message).toBe("The uploaded pack is for @acme/other, not @acme/one.");
            const wrongVersion = await prepare([uploadRow("@acme/other", "1.0.1", bytes)], blobs);
            expect(wrongVersion.errors[0].message).toBe("The uploaded pack is version 1.0.0, not 1.0.1.");
        });

        it("skips a pack that isn't a valid pack, or depends on a path or URL", async () => {
            const junk = zlib.gzipSync(Buffer.from("not a tar"));
            const bad = await prepare([uploadRow("@acme/one", "1.0.0", junk)], blobStore({ [pluginUploadBlobKey(junk)]: junk }));
            expect(bad.errors[0].message).toMatch(/isn't a valid plugin package/);

            const local = plugin("@acme/one", "1.0.0", { dependencies: { left: "file:../../etc" } });
            const refused = await prepare([uploadRow("@acme/one", "1.0.0", local)], blobStore({ [pluginUploadBlobKey(local)]: local }));
            expect(refused.errors[0].message).toMatch(/depends on left from "file:..\/..\/etc"/);

            const registry = plugin("@acme/one", "1.0.0", { dependencies: { left: "^1.0.0", right: "npm:left@1" } });
            expect((await prepare([uploadRow("@acme/one", "1.0.0", registry)], blobStore({ [pluginUploadBlobKey(registry)]: registry }))).errors).toEqual([]);
        });

        it("refuses the packages the server shares with its plugins, a bad blob key and a name set in system:plugins:sources", async () => {
            for (const name of ["@rapidrest/core", "@rapidrest/service-core", "@rapidmx/restapi"]) {
                const bytes = plugin(name, "1.0.0");
                const result = await prepare([uploadRow(name, "1.0.0", bytes)], blobStore({ [pluginUploadBlobKey(bytes)]: bytes }));
                expect(result.desired.size).toBe(0);
                expect(result.errors[0].message).toMatch(/package the server shares with its plugins/);
            }
            const bytes = plugin("@acme/one", "1.0.0");
            const blobs = blobStore({ "mailboxes/secret": bytes, [`${PLUGIN_UPLOAD_BLOB_PREFIX}../x.tgz`]: bytes });
            for (const key of ["mailboxes/secret", `${PLUGIN_UPLOAD_BLOB_PREFIX}../x.tgz`, undefined]) {
                const result = await prepare([uploadRow("@acme/one", "1.0.0", bytes, { uploadBlobKey: key })], blobs);
                expect(result.errors[0].message).toMatch(/no valid blob key/);
            }
            expect(blobs.get).not.toHaveBeenCalled();
            const sourced = await prepare([uploadRow("@acme/one", "1.0.0", bytes)], blobStore({ [pluginUploadBlobKey(bytes)]: bytes }), { configuredSources: new Set(["@acme/one"]) });
            expect(sourced.errors[0].message).toMatch(/system:plugins:sources/);
        });

        it("prunes cached packs no row refers to, and stopped writes, but only when the plugin table was read", async () => {
            const keep = plugin("@acme/one", "1.0.0");
            const drop = plugin("@acme/two", "1.0.0");
            const rows = [uploadRow("@acme/one", "1.0.0", keep), uploadRow("@acme/two", "1.0.0", drop)];
            const blobs = blobStore({ [pluginUploadBlobKey(keep)]: keep, [pluginUploadBlobKey(drop)]: drop });
            await prepare(rows, blobs);
            const cache = path.join(dir, UPLOAD_CACHE_DIR);
            const stale = path.join(cache, `${"a".repeat(64)}.tgz.tmp-1-ab`);
            fs.writeFileSync(stale, "partial");
            fs.utimesSync(stale, new Date(0), new Date(0));
            fs.writeFileSync(path.join(cache, "stray.txt"), "x");
            const fresh = path.join(cache, `${"b".repeat(64)}.tgz.tmp-2-cd`);
            fs.writeFileSync(fresh, "in progress");

            await prepareUploadedPlugins([rows[0]], { config: configWith({}), logger, pluginsDir: dir, blobStore: blobs }, false);
            expect(fs.readdirSync(cache)).toHaveLength(5);

            await prepare([rows[0]], blobs);
            expect(fs.readdirSync(cache).sort()).toEqual([path.basename(fresh), `${sha256(keep)}.tgz`].sort());
        });

        it("builds the configured local blob store the way the server's own injection does", async () => {
            const config = configWith({ "mail:blob:local:root": path.join(dir, "blobs") });
            const { store, close } = await openConfiguredBlobStore(config, logger);
            try {
                const bytes = plugin("@acme/one", "1.0.0");
                const key = pluginUploadBlobKey(bytes);
                expect(store).toBeInstanceOf(LocalFsBlobStore);
                await (store as any).put(key, bytes);
                expect((await store.get(key)).equals(bytes)).toBe(true);
            } finally {
                await close();
            }
        });
    });

    describe("PluginHost", () => {
        const hostOptions = (rows: any[], extra: Record<string, any> = {}) => ({
            config: configWith({ "system:plugins:dir": dir }),
            logger,
            datastore: "mongo" as const,
            pluginClass: class {},
            appRoot: process.cwd(),
            store: new MemoryStore(rows),
            ...extra,
        });
        const installedOf = (name: string, version: string) => ({ name, version, manifest: { ...MANIFEST }, entryUrl: "file:///nope.js" });

        it("installs an upload row through its cached pack, exempt from the allow-list, and skips only the one that fails", async () => {
            const good = plugin("@acme/good", "1.2.3");
            const lost = plugin("@acme/lost", "1.0.0");
            const rows = [
                uploadRow("@acme/good", "1.2.3", good),
                uploadRow("@acme/lost", "1.0.0", lost),
                { uid: "r", name: "@rapidmx/reg", packageVersion: "1.0.0", enabled: true, settings: {}, integrity: "sha512-r" },
                { uid: "n", name: "@evil/reg", packageVersion: "1.0.0", enabled: true, settings: {}, integrity: "sha512-e" },
            ];
            const installer: any = { install: vi.fn(async () => ({ installed: [installedOf("@acme/good", "1.2.3"), installedOf("@rapidmx/reg", "1.0.0")], errors: [] })) };
            const host = await PluginHost.prepare(hostOptions(rows, { installer, blobStore: blobStore({ [pluginUploadBlobKey(good)]: good }) }));

            const desired: any[] = installer.install.mock.calls[0][0];
            expect(desired.map((candidate) => candidate.name)).toEqual(["@acme/good", "@rapidmx/reg"]);
            expect(desired[0]).toEqual({ name: "@acme/good", packageVersion: "1.2.3", integrity: packIntegrity(good), pack: expect.stringMatching(/uploads[\\/][0-9a-f]{64}\.tgz$/) });
            expect(desired[1]).toEqual({ name: "@rapidmx/reg", packageVersion: "1.0.0", integrity: "sha512-r" });
            expect(logger.error).toHaveBeenCalledWith(expect.stringMatching(/Plugin @acme\/lost was not loaded/));
            expect(logger.error).toHaveBeenCalledWith(expect.stringMatching(/Plugin @evil\/reg was not loaded: Its package isn't allowed/));
            expect((host as any).errors.map((error: any) => error.name).sort()).toEqual(["@acme/lost", "@evil/reg"]);
        });

        it("reports a skipped upload in the status errors, and never throws, when the pack can't be read from the blob store", async () => {
            const bytes = plugin("@acme/good", "1.2.3");
            const installer: any = { install: vi.fn(async () => ({ installed: [], errors: [] })) };
            // No cache, and the configured local store has never held the blob.
            const config = configWith({ "system:plugins:dir": dir, "mail:blob:local:root": path.join(dir, "blobs") });
            const host = await PluginHost.prepare(hostOptions([uploadRow("@acme/good", "1.2.3", bytes)], { installer, config }));
            expect(installer.install).toHaveBeenCalledWith([]);
            expect((host as any).errors).toEqual([{ name: "@acme/good", message: expect.stringMatching(/couldn't be read from the blob store/) }]);
        });

        it("still drops a plugin requiring an upload that was skipped", async () => {
            const bytes = plugin("@acme/good", "1.2.3");
            const dependent = { ...installedOf("@rapidmx/dep", "1.0.0"), manifest: { ...MANIFEST, requires: { "@acme/good": "^1.0.0" } } };
            const installer: any = { install: vi.fn(async () => ({ installed: [dependent], errors: [] })) };
            const rows = [uploadRow("@acme/good", "1.2.3", bytes), { uid: "d", name: "@rapidmx/dep", packageVersion: "1.0.0", enabled: true, settings: {}, integrity: "sha512-d" }];
            const host = await PluginHost.prepare(hostOptions(rows, { installer, blobStore: blobStore({}) }));
            expect((host as any).errors.map((error: any) => error.name).sort()).toEqual(["@acme/good", "@rapidmx/dep"]);
        });

        it.skipIf(!npmAvailable)("installs a real upload with npm, verified against the pack's own hash", async () => {
            const good = plugin("@acme/good", "1.2.3");
            const host = await PluginHost.prepare(hostOptions([uploadRow("@acme/good", "1.2.3", good)], { blobStore: blobStore({ [pluginUploadBlobKey(good)]: good }) }));
            expect((host as any).errors).toEqual([]);
            expect(PluginRegistry.list()).toEqual([{ name: "@acme/good", version: "1.2.3" }]);
            const lock = JSON.parse(fs.readFileSync(path.join(dir, "package-lock.json"), "utf8"));
            expect(lock.packages["node_modules/@acme/good"].integrity).toBe(packIntegrity(good));
        }, 120_000);
    });

    describe("PluginInstaller", () => {
        const install = (desired: any[], npm?: any) =>
            new PluginInstaller({ dir, appRoot: process.cwd(), registry: "https://registry.example.com", datastore: "mongo", ...(npm ? { runNpm: npm } : {}) }).install(desired);

        /** An npm stand-in that unpacks a package into node_modules and records `integrity` in the lockfile. */
        const fakeNpm = (version: string, integrity: string) =>
            vi.fn(async (_args: string[], cwd: string) => {
                const target = path.join(cwd, "node_modules", "@acme", "good");
                fs.mkdirSync(target, { recursive: true });
                fs.writeFileSync(path.join(target, "package.json"), JSON.stringify({ name: "@acme/good", version, rapidmx: { plugin: MANIFEST }, exports: { "./mongo": "./index.js" } }));
                fs.writeFileSync(path.join(target, "index.js"), "");
                fs.writeFileSync(path.join(cwd, "package-lock.json"), JSON.stringify({ packages: { "node_modules/@acme/good": { integrity } } }));
            });

        it("installs a pack as a file dependency, checking the version and the lockfile's integrity", async () => {
            const file = path.join(dir, "uploads", "x.tgz");
            const ok = fakeNpm("1.2.3", "sha512-same");
            const result = await install([{ name: "@acme/good", packageVersion: "1.2.3", integrity: "sha512-same", pack: file }], ok);
            expect(result.errors).toEqual([]);
            expect(JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).dependencies).toEqual({ "@acme/good": `file:${path.resolve(file)}` });
            expect(ok.mock.calls[0][0]).toContain("--ignore-scripts");

            fs.rmSync(dir, { recursive: true, force: true });
            const mismatch = await install([{ name: "@acme/good", packageVersion: "1.2.3", integrity: "sha512-same", pack: file }], fakeNpm("1.2.3", "sha512-other"));
            expect(mismatch.installed).toEqual([]);
            expect(mismatch.errors[0].message).toMatch(/integrity hash doesn't match the uploaded pack's/);

            fs.rmSync(dir, { recursive: true, force: true });
            const version = await install([{ name: "@acme/good", packageVersion: "1.2.3", integrity: "sha512-same", pack: file }], fakeNpm("1.2.4", "sha512-same"));
            expect(version.errors[0].message).toMatch(/Expected version 1.2.3, but 1.2.4/);
        });

        it.skipIf(!npmAvailable)("installs a real pack with the real npm, which records the pack's own SHA-512", async () => {
            const bytes = plugin("@acme/good", "1.2.3");
            const file = path.join(dir, "uploads", "good.tgz");
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, bytes);
            const result = await install([{ name: "@acme/good", packageVersion: "1.2.3", integrity: packIntegrity(bytes), pack: file }]);
            expect(result.errors).toEqual([]);
            expect(result.installed[0]).toEqual(expect.objectContaining({ name: "@acme/good", version: "1.2.3", integrity: packIntegrity(bytes) }));

            // A different recorded integrity is refused, whatever npm installed.
            const wrong = await install([{ name: "@acme/good", packageVersion: "1.2.3", integrity: packIntegrity(Buffer.from("other")), pack: file }]);
            expect(wrong.installed).toEqual([]);
            expect(wrong.errors[0].message).toMatch(/doesn't match the uploaded pack's/);
        }, 120_000);
    });

    describe("plugin state hash", () => {
        it("changes when an upload is replaced with different bytes of the same version, and when the source changes", () => {
            const a = plugin("@acme/one", "1.0.0");
            const b = plugin("@acme/one", "1.0.0", { description: "changed" });
            const hash = (row: any) => computePluginStateHash([row]);
            expect(hash(uploadRow("@acme/one", "1.0.0", a))).not.toBe(hash(uploadRow("@acme/one", "1.0.0", b)));
            expect(hash(uploadRow("@acme/one", "1.0.0", a))).not.toBe(hash(uploadRow("@acme/one", "1.0.0", a, { source: "registry" })));
            expect(hash(uploadRow("@acme/one", "1.0.0", a))).toBe(hash(uploadRow("@acme/one", "1.0.0", a, { uploadFilename: "renamed.tgz" })));
        });
    });
});
