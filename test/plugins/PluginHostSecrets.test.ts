///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
// Plugin secret settings in the server's plugin host (spec 5.7): the host decrypts a row's envelopes into the `plugins` config layer, hashes the rows by
// their decrypted values, hides every secret setting from the Diagnostics, and seeds default plugins with their secret defaults encrypted.
import fs from "fs";
import os from "os";
import path from "path";
import nconf from "nconf";
import { Logger } from "@rapidrest/core";
import { ConnectionManager, ObjectFactory } from "@rapidrest/service-core";
import {
    computePluginStateHash,
    ConfigCipher,
    generateConfigKeyring,
    isConfigEnvelope,
    pluginSecretContext,
    type ConfigEnvelope,
} from "@rapidmx/restapi";
import { ConfigKeyStateSQL, PluginSQL } from "@rapidmx/restapi/sql";
import { isHiddenSetting, resetHiddenSettings } from "../../src/diagnostics/hiddenSettings.js";
import { createPluginHostCipher } from "../../src/lib/configEncryption.js";
import { PluginHost } from "../../src/plugins/PluginHost.js";
import { pluginRepository, PluginStateStore, type PluginRepository, type PluginSecretsState } from "../../src/plugins/PluginStateStore.js";
import { PluginWatcher } from "../../src/plugins/PluginWatcher.js";

const MANIFEST = {
    apiVersion: 1,
    displayName: "Hosted",
    settings: [
        { key: "mail:hosted:public_url", label: "URL", type: "string" },
        { key: "mail:hosted:api_token", label: "Token", type: "string", secret: true },
        { key: "mail:hosted:pin", label: "PIN", type: "number", secret: true },
        { key: "mail:hosted:smtp_password", label: "SMTP password", type: "string" },
        { key: "mail:hosted:region", label: "Region", type: "string" },
    ],
};

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

function configWith(values: Record<string, any>) {
    const conf = new nconf.Provider();
    conf.use("memory");
    conf.defaults({ base_path: "./src/mongo", ...values });
    return conf;
}

function row(uid: string, settings: Record<string, any>, extra: Record<string, any> = {}) {
    return { uid, name: "@rapidmx/hosted", packageVersion: "1.0.0", enabled: true, settings, manifest: MANIFEST, ...extra } as any;
}

const installed = (manifest: any = MANIFEST) => ({ name: "@rapidmx/hosted", version: "1.0.0", manifest, entryUrl: "file:///nope.js" });

class MemoryStore extends PluginStateStore {
    constructor(public rows: any[]) {
        super(undefined, logger, "mongo", class {});
    }

    public async withRepository<R>(work: (repo: any) => Promise<R>): Promise<R> {
        return work({ find: async () => [...this.rows], save: async (entity: any) => this.rows.push(entity) });
    }
}

describe("plugin secret settings in the plugin host", () => {
    const keyring = generateConfigKeyring();
    let factory: ObjectFactory;
    let cipher: ConfigCipher;

    beforeEach(async () => {
        factory = new ObjectFactory(configWith({ config_encryption: { keyring: JSON.stringify(keyring) } }), new Logger());
        // What the worker builds for the host: restapi's cipher, with no datastore behind it.
        cipher = await createPluginHostCipher(factory);
    });

    afterEach(async () => {
        resetHiddenSettings();
        await factory.destroy();
    });

    const seal = (uid: string, key: string, value: string | number | boolean): ConfigEnvelope => cipher.encrypt(value, pluginSecretContext(uid, key));

    async function prepare(rows: any[], options: { cipher?: any; config?: any } = {}) {
        const installer: any = { install: vi.fn(async () => ({ installed: [installed()], errors: [] })) };
        const config = options.config ?? configWith({});
        const host = await PluginHost.prepare({
            config,
            logger,
            datastore: "mongo",
            pluginClass: class {},
            appRoot: process.cwd(),
            store: new MemoryStore(rows),
            installer,
            ...("cipher" in options ? { cipher: options.cipher } : { cipher }),
        });
        return { config, host };
    }

    it("puts the decrypted value of a secret setting in the plugins layer, so the plugin reads plaintext", async () => {
        const { config } = await prepare([
            row("p-1", {
                "mail:hosted:public_url": "https://mail.example.com/hosted",
                "mail:hosted:api_token": seal("p-1", "mail:hosted:api_token", "tok-123"),
                "mail:hosted:pin": seal("p-1", "mail:hosted:pin", 4711),
            }),
        ]);
        expect(config.get("mail:hosted:api_token")).toBe("tok-123");
        // A number comes back as a number, not as the JSON text it was sealed as.
        expect(config.get("mail:hosted:pin")).toBe(4711);
        expect(config.get("mail:hosted:public_url")).toBe("https://mail.example.com/hosted");
    });

    it("uses a plaintext secret setting as it is, which is what a row holds until the encryption run has completed", async () => {
        const { config } = await prepare([row("p-1", { "mail:hosted:api_token": "plain-token" })]);
        expect(config.get("mail:hosted:api_token")).toBe("plain-token");
    });

    it("leaves out a secret it can't decrypt, so the deployment's value applies, and names it without its value", async () => {
        logger.warn.mockClear();
        // Sealed for another plugin row: an envelope copied across rows does not open.
        const foreign = seal("someone-else", "mail:hosted:api_token", "stolen-token");
        const { config } = await prepare(
            [row("p-1", { "mail:hosted:api_token": foreign, "mail:hosted:pin": { ...seal("p-1", "mail:hosted:pin", 1), kid: "gone0000" } })],
            { config: configWith({ mail: { hosted: { api_token: "from-deployment" } } }) },
        );
        expect(config.get("mail:hosted:api_token")).toBe("from-deployment");
        expect(config.get("mail:hosted:pin")).toBeUndefined();
        const warnings: string = logger.warn.mock.calls.map((call) => String(call[0])).join("\n");
        expect(warnings).toMatch(/@rapidmx\/hosted.*mail:hosted:api_token/);
        expect(warnings).toMatch(/@rapidmx\/hosted.*mail:hosted:pin/);
        expect(warnings).not.toMatch(/stolen-token|tok-/);
        expect(warnings).not.toContain(foreign.ct);
    });

    it("never applies an envelope as a setting's value, even with no cipher at all", async () => {
        logger.warn.mockClear();
        const { config } = await prepare([row("p-1", { "mail:hosted:api_token": seal("p-1", "mail:hosted:api_token", "tok-123") })], { cipher: undefined });
        expect(config.get("mail:hosted:api_token")).toBeUndefined();
        expect(isConfigEnvelope(config.get("mail:hosted:api_token"))).toBe(false);
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("mail:hosted:api_token"));
    });

    it("hashes the rows by their decrypted values, so neither the encryption run nor a re-encryption reloads the plugins", async () => {
        const plaintext = row("p-1", { "mail:hosted:api_token": "tok-123", "mail:hosted:region": "eu" });
        const encrypted = row("p-1", { "mail:hosted:api_token": seal("p-1", "mail:hosted:api_token", "tok-123"), "mail:hosted:region": "eu" });
        const reEncrypted = row("p-1", { "mail:hosted:api_token": seal("p-1", "mail:hosted:api_token", "tok-123"), "mail:hosted:region": "eu" });
        const changed = row("p-1", { "mail:hosted:api_token": seal("p-1", "mail:hosted:api_token", "tok-456"), "mail:hosted:region": "eu" });

        const loaded = (await prepare([encrypted])).host.loadedHash;
        expect(loaded).toBe(computePluginStateHash([plaintext], cipher));
        expect(loaded).toBe((await prepare([reEncrypted])).host.loadedHash);
        // A new value does reload them.
        expect((await prepare([changed])).host.loadedHash).not.toBe(loaded);
    });

    it("hands the watcher the cipher, so its idea of the desired hash is the host's", async () => {
        const rows = [row("p-1", { "mail:hosted:api_token": seal("p-1", "mail:hosted:api_token", "tok-123") })];
        const { host } = await prepare(rows);
        const watcher: any = new PluginWatcher({
            instance: "i",
            loadedHash: host.loadedHash,
            status: { loaded: [], errors: [], safeMode: false },
            readPlugins: async () => rows,
            restart: async () => undefined,
            logger,
            cipher,
        });
        expect(await watcher.desiredHash()).toBe(host.loadedHash);
        const without: any = new PluginWatcher({
            instance: "i",
            loadedHash: host.loadedHash,
            status: { loaded: [], errors: [], safeMode: false },
            readPlugins: async () => rows,
            restart: async () => undefined,
            logger,
        });
        // With no cipher an envelope is left out, as the host would leave it out: the hashes then differ, which is why every copy must pass its own.
        expect(await without.desiredHash()).not.toBe(host.loadedHash);
    });

    it("hides every secret setting from the Diagnostics - declared secret, a password, or named like one - and only those", async () => {
        const manifest = {
            ...MANIFEST,
            settings: [...MANIFEST.settings, { key: "mail:hosted:login", label: "Login", type: "string" }, { key: "mail:hosted:pass", label: "Pass", type: "password" as any }],
        };
        const installer: any = { install: vi.fn(async () => ({ installed: [installed(manifest)], errors: [] })) };
        resetHiddenSettings();
        await PluginHost.prepare({ config: configWith({}), logger, datastore: "mongo", pluginClass: class {}, appRoot: process.cwd(), store: new MemoryStore([]), installer, cipher });

        for (const name of ["mail:hosted:api_token", "mail:hosted:pin", "mail__hosted__SMTP_PASSWORD", "mail:hosted:pass"]) {
            expect(isHiddenSetting(name), name).toBe(true);
        }
        for (const name of ["mail:hosted:public_url", "mail:hosted:region", "mail:hosted:login"]) {
            expect(isHiddenSetting(name), name).toBe(false);
        }
    });
});

describe("PluginStateStore seeding default plugins with secret settings", () => {
    const keyring = generateConfigKeyring();
    const HOSTED = {
        apiVersion: 1,
        displayName: "Hosted",
        settings: [
            { key: "mail:hosted:api_token", label: "Token", type: "string", secret: true, default: "default-token" },
            { key: "mail:hosted:region", label: "Region", type: "string", default: "eu" },
        ],
    };
    const registry: any = { getVersion: vi.fn(async (name: string) => ({ name, version: "2.0.0", integrity: "sha512-x", manifest: HOSTED })) };
    let factory: ObjectFactory;
    let cipher: ConfigCipher;

    beforeEach(async () => {
        factory = new ObjectFactory(configWith({ config_encryption: { keyring: JSON.stringify(keyring) } }), new Logger());
        cipher = await createPluginHostCipher(factory);
        logger.warn.mockClear();
    });

    afterEach(async () => {
        await factory.destroy();
    });

    class FakeEntity {
        public uid: string = "generated-uid";
        constructor(fields: any) {
            Object.assign(this, fields);
        }
    }

    /** A store over an in-memory table, whose key state says whether the first encryption run has completed and which key a rotation has activated. */
    function storeWith(state: () => Promise<{ encrypted: boolean; activeKid?: string }>) {
        const saved: any[] = [];
        const read = vi.fn(state);
        const store = new (class extends PluginStateStore {
            public async withRepository<R>(work: (repo: PluginRepository, state: PluginSecretsState) => Promise<R>): Promise<R> {
                return work({ find: async () => [...saved], save: async (entity: any) => saved.push(entity) }, { pluginSecrets: read });
            }
        })(undefined, logger, "mongo", FakeEntity, { cipher, configKeyStateClass: class {} });
        return { store, saved, read };
    }

    it("seals a secret default for the row it is seeded as once the encryption run has completed, leaving other settings in plaintext", async () => {
        const { store, saved } = storeWith(async () => ({ encrypted: true }));
        await store.loadAndSeed([{ name: "@rapidmx/hosted" }], () => registry, {});
        const settings = saved[0].settings;
        expect(isConfigEnvelope(settings["mail:hosted:api_token"])).toBe(true);
        expect(settings["mail:hosted:region"]).toBe("eu");
        // Bound to the uid the row has and to the setting: it opens there, and nowhere else.
        expect(cipher.decrypt(settings["mail:hosted:api_token"], pluginSecretContext(saved[0].uid, "mail:hosted:api_token"))).toBe("default-token");
        expect(() => cipher.decrypt(settings["mail:hosted:api_token"], pluginSecretContext("other", "mail:hosted:api_token"))).toThrow();
        expect(JSON.stringify(settings)).not.toContain("default-token");
    });

    it("seeds a secret default in plaintext until the encryption run has completed, which a pod of the previous release may still be reading", async () => {
        const { store, saved } = storeWith(async () => ({ encrypted: false }));
        await store.loadAndSeed([{ name: "@rapidmx/hosted" }], () => registry, {});
        expect(saved[0].settings["mail:hosted:api_token"]).toBe("default-token");
    });

    it("seeds a secret default in plaintext, not under a key a rotation is retiring, once a rotation has made another key active", async () => {
        const { store, saved } = storeWith(async () => ({ encrypted: true, activeKid: "k2" }));
        await store.loadAndSeed([{ name: "@rapidmx/hosted" }], () => registry, {});
        expect(saved[0].settings["mail:hosted:api_token"]).toBe("default-token");
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("another configuration key active"));
    });

    it("seals a secret default when the key the rotation made active is the one this cipher encrypts with", async () => {
        const { store, saved } = storeWith(async () => ({ encrypted: true, activeKid: cipher.currentKid() }));
        await store.loadAndSeed([{ name: "@rapidmx/hosted" }], () => registry, {});
        expect(isConfigEnvelope(saved[0].settings["mail:hosted:api_token"])).toBe(true);
    });

    it("reads the key state only when something seeded holds a secret", async () => {
        const plain: any = { getVersion: vi.fn(async (name: string) => ({ name, version: "1.0.0", integrity: "x", manifest: { apiVersion: 1, displayName: "P", settings: [{ key: "mail:p:region", label: "R", type: "string", default: "eu" }] } })) };
        const { store, saved, read } = storeWith(async () => ({ encrypted: true }));
        await store.loadAndSeed([{ name: "@rapidmx/plain" }], () => plain, {});
        expect(saved).toHaveLength(1);
        expect(read).not.toHaveBeenCalled();
    });

    it("seeds in plaintext, to be encrypted by the encryption run, when the key state can't be read", async () => {
        const { store, saved } = storeWith(async () => {
            throw new Error("datastore down");
        });
        await store.loadAndSeed([{ name: "@rapidmx/hosted" }], () => registry, {});
        expect(saved[0].settings["mail:hosted:api_token"]).toBe("default-token");
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("datastore down"));
    });

    it("leaves a default for the next start, adding nothing, when its secret can't be sealed", async () => {
        const { store, saved } = storeWith(async () => ({ encrypted: true }));
        (store as any).secrets = { cipher: { encrypt: () => { throw new Error("No configuration keyring is loaded"); } }, configKeyStateClass: class {} };
        await store.loadAndSeed([{ name: "@rapidmx/hosted" }], () => registry, {});
        expect(saved).toEqual([]);
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("No configuration keyring is loaded"));
    });

    it("reads the key state from the datastore through the short-lived plugin connection, and leaves the server's models connectable", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-store-secrets-"));
        const sqlLogger = { ...logger, child: () => sqlLogger, log: vi.fn() };
        const datastores = { sql: { type: "better-sqlite3", host: "localhost", database: path.join(dir, "plugins.db"), synchronize: true } };
        const config = configWith({ datastores });
        const setup = new ObjectFactory(config, sqlLogger);
        try {
            const manager: ConnectionManager = await setup.newInstance(ConnectionManager, { name: "setup" });
            await manager.connect({ "sql-setup": { ...datastores.sql, entities: [PluginSQL.name, ConfigKeyStateSQL.name] } }, new Map<string, any>([[PluginSQL.name, PluginSQL], [ConfigKeyStateSQL.name, ConfigKeyStateSQL]]));
            await pluginRepository(manager.connections.get("sql-setup"), ConfigKeyStateSQL).save(new ConfigKeyStateSQL({ uid: "config-keys", pluginSecrets: { encryptedAt: new Date() } }));
            await manager.disconnect();

            const store = new PluginStateStore(config, sqlLogger, "sql", PluginSQL, { cipher, configKeyStateClass: ConfigKeyStateSQL });
            const rows = await store.loadAndSeed([{ name: "@rapidmx/hosted" }], () => registry, {});
            expect(isConfigEnvelope(rows[0].settings["mail:hosted:api_token"])).toBe(true);
            expect(rows[0].settings["mail:hosted:region"]).toBe("eu");
            expect(cipher.decrypt(rows[0].settings["mail:hosted:api_token"] as ConfigEnvelope, pluginSecretContext(rows[0].uid, "mail:hosted:api_token"))).toBe("default-token");
            expect(PluginSQL.datasource).not.toBe("sql-plugin-state");
        } finally {
            await setup.destroy();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
