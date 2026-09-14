///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2020-2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import {
    assertProductionSecretsAreSet,
    DEFAULT_AUTH_SECRET,
    DEFAULT_COOKIE_SECRET,
    DEFAULT_MAIL_INGEST_SECRET,
    SecretsConfig,
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
    it("is a no-op in an explicit development environment, even with every default secret still in effect", () => {
        for (const env of ["dev", "development", "test"]) {
            expect(() => assertProductionSecretsAreSet(fakeConfig({}), env)).not.toThrow();
        }
    });

    it("enforces real secrets when NODE_ENV is unset or anything other than dev/development/test", () => {
        for (const env of [undefined, "production", "staging", "prod", "Development"]) {
            expect(() => assertProductionSecretsAreSet(fakeConfig({}), env)).toThrow(/Refusing to start/);
        }
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
