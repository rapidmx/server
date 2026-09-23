///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2020-2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import {
    assertProductionSecretsAreSet,
    DEFAULT_AUTH_SECRET,
    DEFAULT_COOKIE_SECRET,
    DEFAULT_MAIL_INGEST_SECRET,
    ensurePushDatastore,
    SECRETS_GUARD_SKIP_ENVIRONMENTS,
    SecretsConfig,
    trustedAuthservIdWarning,
} from "../src/config.defaults.js";

type FakeConfigKey = "cookie_secret" | "auth:secret" | "mail:transport:ingest:secret";

function fakeConfig(overrides: Partial<Record<FakeConfigKey, string>>): SecretsConfig {
    const values: Record<string, string> = {
        cookie_secret: DEFAULT_COOKIE_SECRET,
        "auth:secret": DEFAULT_AUTH_SECRET,
        "mail:transport:ingest:secret": DEFAULT_MAIL_INGEST_SECRET,
        ...overrides,
    };
    return { get: (key: string) => values[key] };
}

const realSecrets = {
    cookie_secret: "unique-cookie-secret",
    "auth:secret": "unique-auth-secret",
    "mail:transport:ingest:secret": "unique-ingest-secret",
};

describe("assertProductionSecretsAreSet", () => {
    it("is a no-op in an explicit dev/development environment, even with every default secret still in effect", () => {
        expect(SECRETS_GUARD_SKIP_ENVIRONMENTS).toEqual(["dev", "development"]);
        for (const env of SECRETS_GUARD_SKIP_ENVIRONMENTS) {
            expect(() => assertProductionSecretsAreSet(fakeConfig({}), env)).not.toThrow();
        }
    });

    it("enforces real secrets when NODE_ENV is unset or anything other than dev/development", () => {
        for (const env of [undefined, "production", "staging", "prod", "Development"]) {
            expect(() => assertProductionSecretsAreSet(fakeConfig({}), env)).toThrow(/Refusing to start/);
        }
    });

    it("still enforces real secrets under NODE_ENV=test - unlike dev/development, 'test' does not skip this guard, even though the test suite itself runs under NODE_ENV=test and other dev-only behaviors (registerMailProviders, dev auto-login) do treat it as a development environment", () => {
        expect(() => assertProductionSecretsAreSet(fakeConfig({}), "test")).toThrow(
            /Refusing to start \(NODE_ENV=test\)/,
        );
        expect(() => assertProductionSecretsAreSet(fakeConfig({}), "test")).toThrow(
            /cookie_secret, auth__secret, mail__transport__ingest__secret/,
        );
    });

    it("throws naming every secret still at its default, by the env var name nconf actually reads", () => {
        expect(() => assertProductionSecretsAreSet(fakeConfig({}), "production")).toThrow(
            /cookie_secret, auth__secret, mail__transport__ingest__secret/,
        );
    });

    it("throws naming only the specific secret(s) still at their default", () => {
        const config = fakeConfig({
            "auth:secret": "a-real-unique-secret",
            "mail:transport:ingest:secret": "a-real-ingest-secret",
        });
        expect(() => assertProductionSecretsAreSet(config, "production")).toThrow(/: cookie_secret\. /);
    });

    it("rejects an empty or blank secret too", () => {
        expect(() => assertProductionSecretsAreSet(fakeConfig({ ...realSecrets, "auth:secret": "  " }), "production")).toThrow(
            /auth__secret/,
        );
    });

    it("does not throw once all three secrets have been overridden", () => {
        expect(() => assertProductionSecretsAreSet(fakeConfig(realSecrets), "production")).not.toThrow();
        expect(() => assertProductionSecretsAreSet(fakeConfig(realSecrets), undefined)).not.toThrow();
    });
});

describe("trustedAuthservIdWarning", () => {
    const configWith = (value: unknown): SecretsConfig => ({
        get: (key: string) => (key === "mail:security:trusted_authserv_id" ? value : undefined),
    });

    it("warns, naming the affected features, while the authserv-id is empty, blank or missing", () => {
        for (const value of ["", "   ", undefined]) {
            const warning = trustedAuthservIdWarning(configWith(value));
            expect(warning).toMatch(/mail__security__trusted_authserv_id/);
            expect(warning).toMatch(/members-only distribution lists are dropped/);
            expect(warning).toMatch(/rewritten From/);
            expect(warning).toMatch(/forwarded calendar invites are refused/);
            expect(warning).not.toMatch(/[\r\n]/);
        }
    });

    it("says nothing once it is set", () => {
        expect(trustedAuthservIdWarning(configWith("mx.example.com"))).toBeUndefined();
    });
});

describe("ensurePushDatastore", () => {
    function storeOf(initial: Record<string, unknown>): { get(key: string): unknown; set(key: string, value: unknown): void; values: Record<string, unknown> } {
        const values: Record<string, unknown> = { ...initial };
        return { values, get: (key: string) => values[key], set: (key: string, value: unknown) => void (values[key] = value) };
    }

    it("copies the events datastore to notifications, the one service-core publishes push events through", () => {
        const events = { type: "redis", url: "redis://cache-host:6380/2" };
        const config = storeOf({ "datastores:events": events });
        ensurePushDatastore(config);
        expect(config.values["datastores:notifications"]).toEqual(events);
        // a copy, so changing one datastore never changes the other
        expect(config.values["datastores:notifications"]).not.toBe(events);
    });

    it("keeps a notifications datastore that is configured explicitly", () => {
        const explicit = { type: "redis", url: "redis://elsewhere" };
        const config = storeOf({ "datastores:events": { type: "redis", url: "redis://cache-host" }, "datastores:notifications": explicit });
        ensurePushDatastore(config);
        expect(config.values["datastores:notifications"]).toBe(explicit);
    });

    it("does nothing without an events datastore", () => {
        const config = storeOf({});
        ensurePushDatastore(config);
        expect(config.values).toEqual({});
    });

    describe("in the shipped configuration", () => {
        const saved = { ...process.env };
        afterEach(() => {
            for (const key of Object.keys(process.env)) {
                if (!(key in saved)) delete process.env[key];
            }
            Object.assign(process.env, saved);
            vi.resetModules();
        });

        for (const file of ["../src/config.mongo.js", "../src/config.sql.js"]) {
            it(`${file} publishes on the events datastore's Redis, whatever the environment points it at`, async () => {
                vi.resetModules();
                process.env.datastores__events__url = "redis://push-host:6390/4";
                const { default: conf } = await import(file);
                expect(conf.get("datastores:notifications")).toEqual({ type: "redis", url: "redis://push-host:6390/4" });
                expect(conf.get("datastores:events:url")).toBe("redis://push-host:6390/4");
            });
        }
    });
});
