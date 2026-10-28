///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import nconf from "nconf";
import { Logger } from "@rapidrest/core";
import { ObjectFactory } from "@rapidrest/service-core";
import { ConfigCipher, ConfigKeyHeartbeat, generateConfigKeyring, parseConfigKeyring } from "@rapidmx/restapi";
import { SECRETS_GUARD_SKIP_ENVIRONMENTS, type SecretsConfig } from "../../src/config.defaults.js";
import { TrackedConfigCipherMongo } from "../../src/secrets/TrackedConfigCipherMongo.js";
import { assertConfigKeyringIsSet, createPluginHostCipher, ensureDevelopmentKeyring, startConfigEncryption } from "../../src/lib/configEncryption.js";

const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() });

class FakeEncryptor {}

/** An ObjectFactory that builds what `instances` maps the class to, recording the names asked for. */
function fakeFactory(instances: Map<any, any>) {
    const asked: { type: any; name?: string }[] = [];
    return {
        asked,
        factory: {
            register: vi.fn(),
            newInstance: vi.fn(async (type: any, options?: { name?: string }) => {
                asked.push({ type, name: options?.name });
                const made = instances.get(type);
                if (made instanceof Error) {
                    throw made;
                }
                return made;
            }),
        },
    };
}

/** A promise that settles when told to, so a test can hold the encryptor's run open. */
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => (resolve = r));
    return { promise, resolve };
}

describe("startConfigEncryption", () => {
    it("builds the keyring heartbeat and starts the plugin secret encryption in the background, without waiting for it", async () => {
        const run = deferred<any>();
        const encryptor = { runUntilEncrypted: vi.fn(() => run.promise) };
        const heartbeat = {};
        const { factory, asked } = fakeFactory(new Map<any, any>([[ConfigKeyHeartbeat, heartbeat], [FakeEncryptor, encryptor]]));

        // Returns while the run is still waiting for the rollout: startup is never delayed by it.
        const runtime = await startConfigEncryption(factory, FakeEncryptor, logger());

        expect(asked).toEqual([
            { type: ConfigKeyHeartbeat, name: "default" },
            { type: FakeEncryptor, name: "default" },
        ]);
        expect(encryptor.runUntilEncrypted).toHaveBeenCalledTimes(1);
        const options = (encryptor.runUntilEncrypted.mock.calls as any[][])[0][0];
        expect(options.signal.aborted).toBe(false);

        run.resolve({ encrypted: [], dropped: [], remaining: [], completed: true });
        await runtime.stop();
    });

    it("stops waiting for the rollout when the server stops", async () => {
        const run = deferred<any>();
        const encryptor = {
            runUntilEncrypted: vi.fn(({ signal }: { signal: AbortSignal }) => {
                signal.addEventListener("abort", () => run.resolve({ completed: false }));
                return run.promise;
            }),
        };
        const { factory } = fakeFactory(new Map<any, any>([[ConfigKeyHeartbeat, {}], [FakeEncryptor, encryptor]]));
        const runtime = await startConfigEncryption(factory, FakeEncryptor, logger());
        const signal: AbortSignal = (encryptor.runUntilEncrypted.mock.calls as any[][])[0][0].signal;

        await runtime.stop();

        expect(signal.aborted).toBe(true);
        // Stopping twice is harmless.
        await runtime.stop();
    });

    it("keeps starting when the encryption run fails, and says so", async () => {
        const encryptor = { runUntilEncrypted: vi.fn(async () => Promise.reject(new Error("datastore down"))) };
        const { factory } = fakeFactory(new Map<any, any>([[ConfigKeyHeartbeat, {}], [FakeEncryptor, encryptor]]));
        const log = logger();
        const runtime = await startConfigEncryption(factory, FakeEncryptor, log);
        await runtime.stop();
        expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("datastore down"));
    });

    it("keeps starting when either piece can't be built, running the other", async () => {
        const encryptor = { runUntilEncrypted: vi.fn(async () => ({ completed: true })) };
        const noHeartbeat = fakeFactory(new Map<any, any>([[ConfigKeyHeartbeat, new Error("no ConfigCipher")], [FakeEncryptor, encryptor]]));
        const log = logger();
        await (await startConfigEncryption(noHeartbeat.factory, FakeEncryptor, log)).stop();
        expect(encryptor.runUntilEncrypted).toHaveBeenCalledTimes(1);
        expect(log.error).toHaveBeenCalledWith(expect.stringContaining("no ConfigCipher"));

        const noEncryptor = fakeFactory(new Map<any, any>([[ConfigKeyHeartbeat, {}], [FakeEncryptor, new Error("no Plugin repo")]]));
        const log2 = logger();
        await (await startConfigEncryption(noEncryptor.factory, FakeEncryptor, log2)).stop();
        expect(log2.error).toHaveBeenCalledWith(expect.stringContaining("no Plugin repo"));
    });
});

describe("createPluginHostCipher", () => {
    const keyring = JSON.stringify(generateConfigKeyring());
    const config = () => {
        const conf = new nconf.Provider();
        conf.use("memory");
        conf.defaults({ config_encryption: { keyring } });
        return conf;
    };
    const context = { record: "Plugin", uid: "p-1", field: "settings.api_token" };

    it("builds restapi's own cipher with no datastore, even when the datastore-reading one is registered as ConfigCipher", async () => {
        const factory = new ObjectFactory(config(), new Logger());
        try {
            // What registerCoreProviders() does before the plugin host is prepared: the routes' cipher takes the "ConfigCipher" name, and its init() needs a
            // connected datastore, which the host runs before.
            factory.register(TrackedConfigCipherMongo, "ConfigCipher");

            const cipher = await createPluginHostCipher(factory);
            expect(Object.getPrototypeOf(cipher)).toBe(ConfigCipher.prototype);
            expect(cipher.decrypt(cipher.encrypt("s3cret", context), context)).toBe("s3cret");

            // It is not what @Inject("ConfigCipher") resolves to: the first "ConfigCipher" instance is left for the registered class.
            expect(factory.getInstance("ConfigCipher")).toBeUndefined();
        } finally {
            await factory.destroy();
        }
    });
});

describe("assertConfigKeyringIsSet", () => {
    const keyring = JSON.stringify(generateConfigKeyring());
    const configWith = (values: Record<string, unknown>): SecretsConfig => ({ get: (key: string) => values[key] });

    it("refuses to start without a usable keyring unless NODE_ENV is explicitly dev/development, as for the JWT secret", () => {
        for (const env of [undefined, "production", "staging", "test"]) {
            expect(() => assertConfigKeyringIsSet(configWith({}), env), String(env)).toThrow(/configuration keyring is required/);
        }
        for (const env of SECRETS_GUARD_SKIP_ENVIRONMENTS) {
            expect(() => assertConfigKeyringIsSet(configWith({}), env), env).not.toThrow();
        }
    });

    it("takes the keyring from the file or from the inline setting", () => {
        expect(() => assertConfigKeyringIsSet(configWith({ "config_encryption:keyring": keyring }), "production")).not.toThrow();
        expect(() => assertConfigKeyringIsSet(configWith({ "config_encryption:keyring": JSON.parse(keyring) }), "production")).not.toThrow();
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keyring-"));
        const file = path.join(dir, "keyring.json");
        try {
            fs.writeFileSync(file, keyring);
            expect(() => assertConfigKeyringIsSet(configWith({ "config_encryption:keyring_file": file }), "production")).not.toThrow();
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("refuses a missing, unreadable or malformed keyring, naming the setting and never what it holds", () => {
        expect(() => assertConfigKeyringIsSet(configWith({ "config_encryption:keyring_file": "/nonexistent/keyring.json" }), "production")).toThrow(/keyring_file can't be read/);
        const malformed = '{"keys":[{"kid":"a","key":"a1b2c3-not-a-key"}]}';
        let message = "";
        try {
            assertConfigKeyringIsSet(configWith({ "config_encryption:keyring": malformed }), "production");
        } catch (err: any) {
            message = err.message;
        }
        expect(message).toMatch(/usable configuration keyring is required.*config_encryption:keyring/);
        expect(message).not.toMatch(/a1b2c3/);
    });
});

describe("ensureDevelopmentKeyring", () => {
    const store = (values: Record<string, unknown>) => ({ values, get: (key: string) => values[key], set: (key: string, value: unknown) => void (values[key] = value) });
    let dir: string;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "dev-keyring-"));
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it("generates the keyring file once under yarn dev and points the cipher and the file store at it", async () => {
        const file = path.join(dir, "data", "config-keyring.json");
        const config = store({ "config_encryption:keyring_store:backend": "none" });
        const logger = { info: vi.fn(), warn: vi.fn() };
        await ensureDevelopmentKeyring(config, "development", logger, file);
        expect(config.values["config_encryption:keyring_file"]).toBe(file);
        expect(config.values["config_encryption:keyring_store:backend"]).toBe("file");
        const first = fs.readFileSync(file, "utf8");
        expect(parseConfigKeyring(first).keys).toHaveLength(1);
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining(file));

        // A second start keeps the same keyring: what was encrypted with it stays readable.
        await ensureDevelopmentKeyring(store({}), "dev", logger, file);
        expect(fs.readFileSync(file, "utf8")).toBe(first);
    });

    it("does nothing outside dev/development, where the production guard applies, and leaves a configured keyring alone", async () => {
        const file = path.join(dir, "config-keyring.json");
        for (const env of [undefined, "production", "test"]) {
            const config = store({});
            await ensureDevelopmentKeyring(config, env, { info: vi.fn(), warn: vi.fn() }, file);
            expect(config.values).toEqual({});
        }
        for (const configured of [{ "config_encryption:keyring_file": "/etc/keys.json" }, { "config_encryption:keyring": "{}" }]) {
            const config = store(configured);
            await ensureDevelopmentKeyring(config, "development", { info: vi.fn(), warn: vi.fn() }, file);
            expect(config.values).toEqual(configured);
        }
        expect(fs.existsSync(file)).toBe(false);
    });

    it("keeps a backend that was chosen on purpose, and never overwrites a file that isn't a keyring", async () => {
        const file = path.join(dir, "config-keyring.json");
        const config = store({ "config_encryption:keyring_store:backend": "kubernetes" });
        await ensureDevelopmentKeyring(config, "development", { info: vi.fn(), warn: vi.fn() }, file);
        expect(config.values["config_encryption:keyring_store:backend"]).toBe("kubernetes");

        fs.writeFileSync(file, "not a keyring");
        await expect(ensureDevelopmentKeyring(store({}), "development", { info: vi.fn(), warn: vi.fn() }, file)).rejects.toThrow();
        expect(fs.readFileSync(file, "utf8")).toBe("not a keyring");
    });
});

describe("the entry points", () => {
    const files = ["src/worker.ts", "src/worker.mongo.ts", "src/worker.sql.ts"];

    it("check the production keyring guard where they check the secrets guard, and create the development keyring first thing in start()", () => {
        for (const file of files) {
            const source = fs.readFileSync(file, "utf-8");
            expect(source, file).toMatch(/assertConfigKeyringIsSet\(config, process\.env\.NODE_ENV\)/);
            expect(source.indexOf("assertProductionSecretsAreSet(config"), file).toBeLessThan(source.indexOf("assertConfigKeyringIsSet(config"));
            const start = source.indexOf("const start = async function");
            expect(source.indexOf("await ensureDevelopmentKeyring(config, process.env.NODE_ENV, logger)", start), file).toBeGreaterThan(start);
        }
    });

    it("give the plugin host the cipher and the key state model, and start the encryption after the server is up", () => {
        for (const file of files) {
            const source = fs.readFileSync(file, "utf-8");
            // One cipher, the plugin host's, which the integrations layer decrypts with too.
            expect(source, file).toMatch(/const hostCipher = await createPluginHostCipher\(objectFactory\)/);
            expect(source, file).toMatch(/cipher: hostCipher/);
            expect(source, file).toMatch(/configKeyStateClass: ConfigKeyState(Mongo|SQL)/);
            expect(source.indexOf("await server.start()"), file).toBeLessThan(source.indexOf("await startConfigEncryption("));
            expect(source, file).toMatch(/configEncryption\?\.stop\(\)/);
        }
    });

    it("widen the SQL column types of the Plugin and ConfigKeyState tables before the plugin host's own connection synchronizes them", () => {
        const source = fs.readFileSync("src/worker.sql.ts", "utf-8");
        const widened = source.indexOf("await applySqlColumnTypes(config.get(\"datastores:sql:type\"), [PluginSQL, ConfigKeyStateSQL], logger)");
        expect(widened).toBeGreaterThan(-1);
        expect(widened).toBeLessThan(source.indexOf("await PluginHost.prepare("));
    });

    it("register the datastore's cipher, the one that remembers what it couldn't decrypt, through registerCoreProviders", () => {
        expect(fs.readFileSync("src/worker.mongo.ts", "utf-8")).toMatch(/configCipher: TrackedConfigCipherMongo/);
        expect(fs.readFileSync("src/worker.ts", "utf-8")).toMatch(/configCipher: TrackedConfigCipherMongo/);
        expect(fs.readFileSync("src/worker.sql.ts", "utf-8")).toMatch(/configCipher: TrackedConfigCipherSQL/);
    });
});
