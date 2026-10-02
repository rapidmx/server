///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2020-2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import {
    applyPluginSetting,
    isProtectedPluginSettingKey,
    isAllowedPluginSettingKey,
    assertProductionSecretsAreSet,
    DEFAULT_AUTH_SECRET,
    DEFAULT_COOKIE_SECRET,
    DEFAULT_MAIL_INGEST_SECRET,
    ensurePushDatastore,
    PLUGIN_SETTINGS_STORE,
    SECRETS_GUARD_SKIP_ENVIRONMENTS,
    SecretsConfig,
    escrowAuditKeyWarning,
    trustedAuthservIdWarning,
    weakIngestSecretWarning,
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

    it("does not refuse to start over a short ingest secret, which an upgrade must survive, but warns about it outside development", () => {
        const short = fakeConfig({ ...realSecrets, "mail:transport:ingest:secret": "short" });
        expect(() => assertProductionSecretsAreSet(short, "production")).not.toThrow();
        expect(weakIngestSecretWarning(short, "production")).toMatch(/mail__transport__ingest__secret.*shorter than 16/);
        expect(weakIngestSecretWarning(short, "development")).toBeUndefined();
        expect(weakIngestSecretWarning(fakeConfig(realSecrets), "production")).toBeUndefined();
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

describe("escrowAuditKeyWarning", () => {
    const configWith = (value: unknown): SecretsConfig => ({
        get: (key: string) => (key === "mail:escrow:audit_hmac_key" ? value : undefined),
    });

    it("warns in production while the key is empty, blank or missing", () => {
        for (const value of ["", "  ", undefined]) {
            expect(escrowAuditKeyWarning(configWith(value), "production")).toMatch(/mail__escrow__audit_hmac_key.*unkeyed SHA-256/);
            expect(escrowAuditKeyWarning(configWith(value), undefined)).toBeDefined();
        }
    });

    it("says nothing once it is set, or in development", () => {
        expect(escrowAuditKeyWarning(configWith("abc"), "production")).toBeUndefined();
        expect(escrowAuditKeyWarning(configWith(""), "development")).toBeUndefined();
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

describe("isProtectedPluginSettingKey", () => {
    it("protects the core configuration a plugin could use to take over the server, however it is spelled", () => {
        for (const key of [
            "trusted_roles",
            "trusted_proxies",
            "mail:transport:ingest:secret",
            "mail__transport__ingest__secret",
            "auth:secret",
            "auth:options:issuer",
            "cookie_secret",
            "session:secret",
            "Datastores:mongo:url",
            "mail:escrow:audit_hmac_key",
            "system:plugins:sources",
        ]) {
            expect(isProtectedPluginSettingKey(key), key).toBe(true);
        }
    });

    it("still protects the server's own jobs, but not a job a plugin adds", () => {
        for (const key of ["mail:jobs:scan_queue:schedule", "mail:jobs:data_export:schedule", "mail:jobs:scheduled_send"]) {
            expect(isProtectedPluginSettingKey(key), key).toBe(true);
        }
        expect(isProtectedPluginSettingKey("mail:jobs:eas_device_cleanup:schedule")).toBe(false);
    });

    it("leaves plugins their own settings", () => {
        for (const key of ["mail:eas:sync_window_size", "mail:videoconf:turn:url", "mail:booking:public_url", "authentication_banner", "mail:security_note", "crm:stages", "mail:eas:sync_window_size", "mail:eas:provision:password_enabled", "mail:jobs:eas_device_cleanup:device_ttl_days", "mail:autodiscover:public_url", "mail:booking:public_url", "mail:crm:public_url", "mail:crm:verp", "mail:videoconf:public_url", "mail:videoconf:turn:shared_secret", "mail:videoconf:relay:enabled"]) {
            expect(isProtectedPluginSettingKey(key), key).toBe(false);
        }
    });
});

describe("isAllowedPluginSettingKey", () => {
    const declared = ["mail:videoconf:turn:url", "mail:crm:verp", "mail:transport:sendmail:path", "auth:secret"];

    it("allows a key the plugin's manifest declares, however it is spelled", () => {
        expect(isAllowedPluginSettingKey("mail:videoconf:turn:url", declared)).toBe(true);
        expect(isAllowedPluginSettingKey("mail__videoconf__turn__url", declared)).toBe(true);
        expect(isAllowedPluginSettingKey("Mail:CRM:VERP", declared)).toBe(true);
    });

    it("refuses a key the manifest does not declare, even outside every core namespace", () => {
        expect(isAllowedPluginSettingKey("mail:videoconf:turn:credential", declared)).toBe(false);
        expect(isAllowedPluginSettingKey("anything", [])).toBe(false);
    });

    it("refuses a declared key that lives in core configuration", () => {
        expect(isAllowedPluginSettingKey("mail:transport:sendmail:path", declared)).toBe(false);
        expect(isAllowedPluginSettingKey("auth:secret", declared)).toBe(false);
    });

    it("protects the core namespaces that a plugin setting could use to run commands or redirect mail, scanning, DNS or storage", () => {
        for (const key of [
            "mail:transport:sendmail:path",
            "mail:transport:provider",
            "mail:blob:s3:secret_access_key",
            "mail:scan:av:clamav:host",
            "mail:scan:spam:rspamd:url",
            "mail:dns:doh:url",
            "mail:dkim:selector",
            "mail:auto_provision:enabled",
            "mail:domains",
            "metrics:authRequired",
            "diagnostics:enabled",
            "class_loader:path",
            "cluster_url",
            "react:enabled",
            "static_assets:path",
            "giphy:api_key",
            "cookies:secure",
        ]) {
            expect(isProtectedPluginSettingKey(key), key).toBe(true);
        }
    });
});

describe("applyPluginSetting", () => {
    it("writes a nested key to the plugin settings layer, which stays read-only for everything else", () => {
        const store = { readOnly: true, values: {} as Record<string, unknown>, set(key: string, value: unknown) {
            if (this.readOnly) {
                return false;
            }
            this.values[key] = value;
            return true;
        } };
        const set = vi.fn();
        applyPluginSetting({ set, stores: { [PLUGIN_SETTINGS_STORE]: store } }, "mail:x:y", "saved");
        expect(store.values).toEqual({ "mail:x:y": "saved" });
        expect(store.readOnly).toBe(true);
        expect(set).not.toHaveBeenCalled();
    });

    it("locks the layer again when the write throws", () => {
        const store = { readOnly: true, set: () => { throw new Error("nope"); } };
        expect(() => applyPluginSetting({ set: vi.fn(), stores: { [PLUGIN_SETTINGS_STORE]: store } }, "a", 1)).toThrow("nope");
        expect(store.readOnly).toBe(true);
    });

    it("sets the value like any other when there is no such layer", () => {
        const set = vi.fn();
        applyPluginSetting({ set }, "a:b", 2);
        applyPluginSetting({ set, stores: {} }, "c", 3);
        expect(set.mock.calls).toEqual([["a:b", 2], ["c", 3]]);
    });
});
