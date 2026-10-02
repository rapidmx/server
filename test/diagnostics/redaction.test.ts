///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
import nconf from "nconf";
import { DiagnosticsCollector } from "../../src/diagnostics/DiagnosticsCollector.js";
import {
    describeConfiguration,
    describeEnvironment,
    isSecretName,
    MAX_VALUE_LENGTH,
    scrubValue,
} from "../../src/diagnostics/redaction.js";

/** Secrets that must never appear anywhere in a serialized answer. */
const SECRETS = [
    "hunter2-password-value",
    "s3cr3t-token-value",
    "AKIAIOSFODNN7EXAMPLE",
    "webhook-path-secret",
    "sessionid-secret-value",
    "query-param-secret",
    "urlpass-secret",
    "-----BEGIN PRIVATE KEY-----",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJl",
];

function expectNoSecrets(value: unknown) {
    const json = JSON.stringify(value);
    for (const secret of SECRETS) {
        expect(json).not.toContain(secret);
    }
}

describe("isSecretName", () => {
    it.each([
        "DB_PASSWORD",
        "db_passwd",
        "API_KEY",
        "apiKey",
        "GITHUB_TOKEN",
        "mail__transport__ingest__secret",
        "AWS_SECRET_ACCESS_KEY",
        "auth__secret",
        "cookie_secret",
        "PRIVATE_KEY",
        "SESSION_ID",
        "PASSWORD_SALT",
        "SENTRY_DSN",
        "MONGO_CONNECTION_STRING",
        "TLS_CERT",
        "SLACK_WEBHOOK_URL",
        "CREDENTIALS",
    ])("treats %s as a secret", (name) => {
        expect(isSecretName(name)).toBe(true);
    });

    it.each(["NODE_ENV", "TZ", "PORT", "HOSTNAME", "PWD", "LANG", "datastores:cache:type"])("does not treat %s as a secret", (name) => {
        expect(isSecretName(name)).toBe(false);
    });
});

describe("scrubValue", () => {
    it("strips the credentials of a URL", () => {
        expect(scrubValue("mongodb://admin:urlpass-secret@db:27017/mail")).toBe("mongodb://db:27017/mail");
        expect(scrubValue("https://token-only@example.com/x")).toBe("https://example.com/x");
        // A password holding `/` ends the authority early, so where the credential stops is unknowable: hidden whole.
        expect(scrubValue("redis://user:pa/ss@cache:6379")).toBeUndefined();
    });

    it("strips everything up to the last @ of the authority, so a password holding @ is not half-shown", () => {
        expect(scrubValue("redis://:p@ss@host:6379/0")).toBe("redis://host:6379/0");
        expect(scrubValue("redis://u:p@ss@@host:6379")).toBe("redis://host:6379");
    });

    it("hides the whole value when the userinfo holds whitespace", () => {
        expect(scrubValue("postgres://u:pa ss@host/db")).toBeUndefined();
        expect(scrubValue("postgres://u:pa ss/x@host/db")).toBeUndefined();
        // Whitespace after the authority is not userinfo.
        expect(scrubValue("https://example.com/a b")).toBe("https://example.com/a b");
    });

    it("scrubs every URL of a value and leaves a URL without credentials intact", () => {
        expect(scrubValue("a=mongodb://u:p1@h1/x b=redis://:p@2@h2:6379 c=https://example.com:8080/path?x=1#f")).toBe(
            "a=mongodb://h1/x b=redis://h2:6379 c=https://example.com:8080/path?x=1#f"
        );
        expect(scrubValue("https://example.com/path")).toBe("https://example.com/path");
        expect(scrubValue("no url here, a@b.test")).toBe("no url here, a@b.test");
    });

    it("hides the whole value of a URL holding credentials and a secret query parameter", () => {
        expect(scrubValue("redis://:p@ss@host/0?password=query-param-secret&db=1")).toBeUndefined();
    });

    it("hides a value too long to scrub safely, and does so in linear time", () => {
        const started = Date.now();
        expect(scrubValue("a".repeat(200_000))).toBeUndefined();
        expect(scrubValue("?".repeat(200_000))).toBeUndefined();
        expect(Date.now() - started).toBeLessThan(500);
        // A long run of scheme characters just under the cap is scanned in linear time as well.
        const near = Date.now();
        expect(scrubValue("a".repeat(MAX_VALUE_LENGTH * 10))).toBe(`${"a".repeat(MAX_VALUE_LENGTH)}...`);
        expect(Date.now() - near).toBeLessThan(500);
    });

    it("hides the whole value of a URL with a secret-named query parameter, not just that parameter", () => {
        expect(scrubValue("https://x.test/cb?mode=a&api_key=query-param-secret&b=2")).toBeUndefined();
    });

    it("hides a private key block or a JWT entirely", () => {
        expect(scrubValue("-----BEGIN PRIVATE KEY-----\nabc")).toBeUndefined();
        expect(scrubValue("-----BEGIN CERTIFICATE-----\nabc")).toBeUndefined();
        expect(scrubValue("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJl")).toBeUndefined();
    });

    it("leaves a harmless value alone and cuts a very long one", () => {
        expect(scrubValue("plain value")).toBe("plain value");
        const cut = scrubValue("x".repeat(MAX_VALUE_LENGTH + 50));
        expect(cut).toBe(`${"x".repeat(MAX_VALUE_LENGTH)}...`);
    });
});

describe("scrubValue: round-2 findings", () => {
    it("never lets an @ in a URL's path or query cut the host (R2S-1)", () => {
        for (const url of [
            "https://registry.npmjs.org/@scope/pkg",
            "https://medium.com/@user/post",
            "https://h/?redirect=a@b.c",
            "https://h:8080/x#a@b",
            "http://[::1]:8080/@x",
        ]) {
            expect(scrubValue(url)).toBe(url);
        }
        expect(scrubValue("https://u:p@h/@scope/pkg")).toBe("https://h/@scope/pkg");
    });

    it("hides the whole value of a secret-named pair, wherever it stands (R2S-2)", () => {
        for (const value of [
            "Password=abc;Server=x",
            "Server=x;Pwd=abc",
            "Server=x;pw=abc",
            "https://h/blob?sv=1&sig=abc%3D",
            ";Password=my pass;",
            "https://h/?x=1#password=abc",
            "https://h/?password=ab&cd",
            "x=1,secret=abc",
            "api-key=abc",
        ]) {
            expect(scrubValue(value)).toBeUndefined();
        }
        // An empty value holds nothing to hide.
        expect(scrubValue("https://h/?password=&db=1")).toBe("https://h/?password=&db=1");
    });

    it("hides the whole value when a credential's extent cannot be told (R2S-2)", () => {
        for (const value of [
            "postgres://user:pa://x@host/db",
            "x://u:pa/ss word@h",
            "redis://user:pa/ss@cache:6379",
            "user:pass@host:5432/db",
            "//user:pw@host/x",
            "db=user:pass@host:5432/db",
            "Bearer abc123",
            "Basic dXNlcjpwdw==",
            "Authorization: token",
        ]) {
            expect(scrubValue(value)).toBeUndefined();
        }
    });

    it.each([
        "db.example.com",
        "https://example.com/path?x=1",
        "1.2.3",
        "true",
        "a1b2",
        "us-east-1",
        "admin@example.com",
        "mailto:admin@example.com",
        "From: a@b.test",
        "mongodb://db:27017/mail",
        "sslmode=require",
        "a,b,c",
    ])("leaves %s visible", (value) => {
        expect(scrubValue(value)).toBe(value);
    });

    it("scrubs in linear time (R2S-3)", () => {
        for (const filler of ["?", "a", "&", "a b ", "=", ",", ":", "x://", "a:"]) {
            const value = filler.repeat(Math.floor(9000 / filler.length));
            const started = Date.now();
            scrubValue(value);
            expect(Date.now() - started).toBeLessThan(30);
        }
    });
});

describe("describeEnvironment", () => {
    const env = {
        NODE_ENV: "production",
        TZ: "UTC",
        PORT: "3000",
        SMTP_HOST: "smtp.example.com",
        LC_ALL: "C.UTF-8",
        datastores__cache__type: "redis",
        DB_PASSWORD: "hunter2-password-value",
        GITHUB_TOKEN: "s3cr3t-token-value",
        AWS_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
        SLACK_WEBHOOK_URL: "https://hooks.example.com/webhook-path-secret",
        SESSION_STORE: "sessionid-secret-value",
        // Not on the allowlist and not secret-named: hidden because it is unknown.
        MY_APP_SETTING: "urlpass-secret",
        // On the allowlist by name, but the value is a private key: hidden.
        SOME_HOST: "-----BEGIN PRIVATE KEY-----",
        // On the allowlist by name, with credentials in the value: scrubbed.
        REPLICA_HOST: "mongodb://u:urlpass-secret@replica",
        UNSET: undefined,
    };

    it("shows allowlisted names and withholds every other value", () => {
        const result = describeEnvironment(env);
        const byName = Object.fromEntries(result.map((s) => [s.name, s]));
        expect(byName.NODE_ENV).toEqual({ name: "NODE_ENV", value: "production", redacted: false });
        expect(byName.TZ.value).toBe("UTC");
        expect(byName.PORT.value).toBe("3000");
        expect(byName.SMTP_HOST.value).toBe("smtp.example.com");
        expect(byName.LC_ALL.value).toBe("C.UTF-8");
        expect(byName.datastores__cache__type.value).toBe("redis");
        expect(byName.REPLICA_HOST.value).toBe("mongodb://replica");
        for (const name of ["DB_PASSWORD", "GITHUB_TOKEN", "AWS_ACCESS_KEY_ID", "SLACK_WEBHOOK_URL", "SESSION_STORE", "MY_APP_SETTING", "SOME_HOST"]) {
            expect(byName[name]).toEqual({ name, redacted: true });
        }
        expect(byName.UNSET).toBeUndefined();
    });

    it("lists names in order and never contains a secret value", () => {
        const result = describeEnvironment(env);
        expect(result.map((s) => s.name)).toEqual([...result.map((s) => s.name)].sort((a, b) => a.localeCompare(b)));
        expectNoSecrets(result);
    });

    it("never shows a secret-named variable even when its name also matches the allowlist", () => {
        const result = describeEnvironment({ SECRET_HOST: "auth-internal", TOKEN_PORT: "1234" });
        expect(result).toEqual([
            { name: "SECRET_HOST", redacted: true },
            { name: "TOKEN_PORT", redacted: true },
        ]);
    });

    it("shows the harmless variables of a cluster: service discovery, addresses, switches, limits and the auth settings that are not secrets", () => {
        const env = {
            CLAMAV_PORT: "tcp://10.43.73.82:3310",
            CLAMAV_PORT_3310_TCP_ADDR: "10.43.73.82",
            CLAMAV_PORT_3310_TCP_PROTO: "tcp",
            POSTFIX_BRIDGE_SERVICE_PORT_SMTP_DELIVERY: "2525",
            PATH: "/usr/local/bin:/usr/bin",
            auth__options__audience: "mail.example.com",
            auth__options__expiresIn: "1h",
            mail__basic_auth__enabled: "true",
            mail__basic_auth__realm: "Mail",
            mail__basic_auth__failure_limit: "10",
            mail__booking__public_url: "https://mail.example.com/book",
            datastores__mongo__url: "mongodb://mongodb:27017/rrst",
            cors__origins: "https://mail.example.com",
        };
        for (const setting of describeEnvironment(env)) {
            expect(setting.redacted, setting.name).toBe(false);
            expect(setting.value, setting.name).toBe((env as Record<string, string>)[setting.name]);
        }
    });

    it("still hides the secrets among them, and a URL's credentials", () => {
        const result = Object.fromEntries(
            describeEnvironment({
                auth__secret: "s3cret-value",
                cookie_secret: "c",
                mail__scan__spam__rspamd__controller_password: "pw",
                mail__videoconf__turn__shared_secret: "x",
                mail__escrow__audit_hmac_key: "k",
                datastores__cache__url: "redis://:hunter2@cache:6379",
            }).map((s) => [s.name, s]),
        );
        for (const name of ["auth__secret", "cookie_secret", "mail__scan__spam__rspamd__controller_password", "mail__videoconf__turn__shared_secret", "mail__escrow__audit_hmac_key"]) {
            expect(result[name], name).toEqual({ name, redacted: true });
        }
        expect(result.datastores__cache__url.value).toBe("redis://cache:6379");
    });

    it("shows a setting about a secret (a switch, a limit, a policy) but not the secret", () => {
        for (const name of ["mail:eas:provision:allow_simple_password", "mail:eas:provision:min_password_length", "mail:eas:provision:password_enabled", "mail:eas:provision:require_device_encryption", "x__api_key_length"]) {
            expect(isSecretName(name), name).toBe(false);
        }
        for (const name of ["password", "mail:escrow:audit_hmac_key", "controller_password", "mail:transport:ingest:secret", "datastores:mongo:options:ssl_key"]) {
            expect(isSecretName(name), name).toBe(true);
        }
    });
});

describe("describeConfiguration", () => {
    const tree = {
        service_name: "rapidmx",
        cookie_secret: "hunter2-password-value",
        max_body_size: 100,
        enabled: true,
        nothing: null,
        PATH: "/usr/bin",
        _: ["server.js", "--password=hunter2-password-value"],
        $0: "node",
        datastores: {
            cache: { type: "redis", url: "redis://default:urlpass-secret@cache:6379" },
            mongo: { type: "mongodb", host: "db", password: "hunter2-password-value", options: { ssl_key: "-----BEGIN PRIVATE KEY-----" } },
        },
        mail: {
            transport: { ingest: { secret: "s3cr3t-token-value" }, host: "mx" },
            origins: ["https://a.example.com", "https://b.example.com?token=query-param-secret"],
            empty: [],
            none: {},
            banner: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJl",
            callback: () => "x",
            missing: undefined,
        },
        auth: { secret: "hunter2-password-value", cookie: { domain: ".example.com" } },
    };

    it("flattens the tree with nconf-style names and withholds secrets", () => {
        const result = describeConfiguration(tree, { PATH: "/usr/bin" }, ["service_name", "datastores"]);
        const byName = Object.fromEntries(result.map((s) => [s.name, s]));
        expect(byName.service_name.value).toBe("rapidmx");
        expect(byName.max_body_size.value).toBe("100");
        expect(byName.enabled.value).toBe("true");
        expect(byName.nothing.value).toBe("null");
        expect(byName["datastores:cache:type"].value).toBe("redis");
        expect(byName["datastores:cache:url"].value).toBe("redis://cache:6379");
        expect(byName["datastores:mongo:host"].value).toBe("db");
        expect(byName["mail:transport:host"].value).toBe("mx");
        expect(byName["mail:origins:0"].value).toBe("https://a.example.com");
        expect(byName["mail:origins:1"]).toEqual({ name: "mail:origins:1", redacted: true });
        expect(byName["mail:empty"].value).toBe("[]");
        expect(byName["mail:none"].value).toBe("{}");
        expect(byName["mail:callback"]).toEqual({ name: "mail:callback", redacted: true });
        expect(byName["mail:banner"]).toEqual({ name: "mail:banner", redacted: true });
        expect(byName["mail:missing"]).toBeUndefined();
        for (const name of ["cookie_secret", "datastores:mongo:password", "datastores:mongo:options:ssl_key", "mail:transport:ingest:secret", "auth:secret", "auth:cookie"]) {
            expect(byName[name]).toEqual({ name, redacted: true });
        }
        // The subtree of a secret-named key is one hidden entry: not even its shape is listed.
        expect(Object.keys(byName).some((name) => name.startsWith("auth:cookie:"))).toBe(false);
        // Command-line positionals and script are not settings.
        expect(byName._).toBeUndefined();
        expect(byName.$0).toBeUndefined();
        expect(byName["_:0"]).toBeUndefined();
        expectNoSecrets(result);
    });

    it("drops a scalar top-level key that only copies an environment variable, unless the defaults declare it", () => {
        const env = { PATH: "/usr/bin", max_body_size: "5" };
        const result = describeConfiguration({ PATH: "/usr/bin", max_body_size: 5, nested: { PATH: "x" } }, env, ["max_body_size"]);
        expect(result.map((s) => s.name)).toEqual(["max_body_size", "nested:PATH"]);
    });

    it("drops a top-level key that is an environment variable whatever its value parses to", () => {
        const env = { DB_CONFIG: '{"u":"admin","p":"hunter2"}', FOO__BAR: "secretvalue", Mixed_Case: "x", datastores__cache__type: "redis" };
        const result = describeConfiguration(
            {
                DB_CONFIG: { u: "admin", p: "hunter2" },
                FOO: { BAR: "secretvalue" },
                mixed_case: { a: "b" },
                datastores: { cache: { type: "redis" } },
                service_name: "rapidmx",
            },
            env,
            ["datastores", "service_name"]
        );
        expect(result.map((s) => s.name)).toEqual(["datastores:cache:type", "service_name"]);
        expect(JSON.stringify(result)).not.toContain("hunter2");
        expect(JSON.stringify(result)).not.toContain("secretvalue");
    });

    it("keeps a declared key that is also an environment variable name", () => {
        const result = describeConfiguration({ service: { name: "a" } }, { SERVICE__NAME: "a" }, ["service"]);
        expect(result.map((s) => s.name)).toEqual(["service:name"]);
    });

    it("answers nothing for a configuration that is not an object", () => {
        expect(describeConfiguration(undefined, {})).toEqual([]);
        expect(describeConfiguration("text", {})).toEqual([]);
        expect(describeConfiguration(null, {})).toEqual([]);
    });

    it("reads no more of an array than it can list (R2S-3)", () => {
        let reads = 0;
        const items = new Proxy(Array.from({ length: 20_000 }, (_, i) => i), {
            get(target, key, receiver) {
                if (typeof key === "string" && /^\d+$/.test(key)) {
                    reads++;
                }
                return Reflect.get(target, key, receiver);
            },
        });
        expect(describeConfiguration({ items }, {})).toHaveLength(5000);
        expect(reads).toBeLessThanOrEqual(5000);
    });

    it("keeps a top-level key the plugin settings layer holds, even when an environment variable starts with it (R2S-4)", () => {
        const env = { CRM__ENDPOINT: "https://crm.example.com", DB__HOST: "x" };
        const tree = { crm: { endpoint: "https://crm.example.com/v2", region: "eu" }, db: { host: "x" } };
        expect(describeConfiguration(tree, env, []).map((s) => s.name)).toEqual([]);
        expect(describeConfiguration(tree, env, ["crm"]).map((s) => s.name)).toEqual(["crm:endpoint", "crm:region"]);
    });

    it("guards against a cycle, a tree that is too deep and one that is too large", () => {
        const cyclic: Record<string, unknown> = { name: "a" };
        cyclic.self = cyclic;
        expect(describeConfiguration({ cyclic }, {})).toEqual(
            expect.arrayContaining([
                { name: "cyclic:name", value: "a", redacted: false },
                { name: "cyclic:self", redacted: true },
            ])
        );
        let deep: Record<string, unknown> = { leaf: "x" };
        for (let i = 0; i < 20; i++) {
            deep = { d: deep };
        }
        const deepResult = describeConfiguration({ deep }, {});
        expect(deepResult).toHaveLength(1);
        expect(deepResult[0].redacted).toBe(true);
        const wide = Object.fromEntries(Array.from({ length: 6000 }, (_, i) => [`k${i}`, { v: i }]));
        expect(describeConfiguration(wide, {}).length).toBeLessThanOrEqual(5000);
    });
});

describe("DiagnosticsCollector.information", () => {
    it("combines the environment and configuration it is given, with no secret in the JSON", () => {
        const collector = new DiagnosticsCollector({
            env: { NODE_ENV: "production", DB_PASSWORD: "hunter2-password-value", OTHER: "urlpass-secret" },
            configuration: () => ({
                tree: { cookie_secret: "s3cr3t-token-value", service_name: "rapidmx", DB_PASSWORD: "hunter2-password-value" },
                declared: ["service_name"],
            }),
        });
        const information = collector.information();
        expect(information.environment).toEqual([
            { name: "DB_PASSWORD", redacted: true },
            { name: "NODE_ENV", value: "production", redacted: false },
            { name: "OTHER", redacted: true },
        ]);
        expect(information.configuration).toEqual([
            { name: "cookie_secret", redacted: true },
            { name: "service_name", value: "rapidmx", redacted: false },
        ]);
        expectNoSecrets(information);
    });

    it("reads process.env and the shared nconf by default", () => {
        const previous = process.env.RAPIDMX_TEST_PASSWORD;
        process.env.RAPIDMX_TEST_PASSWORD = "hunter2-password-value";
        try {
            const information = new DiagnosticsCollector().information();
            expect(information.environment.find((s) => s.name === "RAPIDMX_TEST_PASSWORD")).toEqual({
                name: "RAPIDMX_TEST_PASSWORD",
                redacted: true,
            });
            expectNoSecrets(information);
        } finally {
            if (previous === undefined) {
                delete process.env.RAPIDMX_TEST_PASSWORD;
            } else {
                process.env.RAPIDMX_TEST_PASSWORD = previous;
            }
        }
    });

    it("lists what the plugin settings layer holds even when an environment variable starts with its key (R2S-4)", () => {
        process.env.RAPIDMX_TESTPLUGIN__REGION = "eu";
        nconf.add("plugins", { type: "literal", store: { rapidmx_testplugin: { region: "us" } } });
        try {
            const names = new DiagnosticsCollector().information().configuration.map((s) => s.name);
            expect(names).toContain("rapidmx_testplugin:region");
        } finally {
            nconf.remove("plugins");
            delete process.env.RAPIDMX_TESTPLUGIN__REGION;
        }
    });
});
