///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
// The integrations config layer (spec 11.1): what the administrator set in the console, decrypted, directly below the plugin settings and above the
// environment and the defaults, rebuilt from the row without a restart.
import nconf from "nconf";
import { ConfigCipher, generateConfigKeyring, integrationSecretContext } from "@rapidmx/restapi";
import { INTEGRATIONS_STORE } from "../../src/config.defaults.js";
import { IntegrationsLayer } from "../../src/integrations/IntegrationsLayer.js";
import { UnreadableSecrets } from "../../src/secrets/UnreadableSecrets.js";
import { keyringCipher, layeredConfig, logger, settingsRow } from "../helpers/integrations.js";

const DEPLOYMENT = {
    giphy: { api_key: "deployment-giphy-key" },
    mail: { dns: { resolver: "node", doh: { endpoint: "https://doh.deployment.example/dns-query" } }, pki: { signing_enrollment: { backend: "manual" } } },
    system: { plugins: { registry: "https://registry.deployment.example", registry_token: "deployment-npm-token" } },
};

describe("IntegrationsLayer", () => {
    let conf: ReturnType<typeof layeredConfig>;
    let cipher: ConfigCipher;
    let log: ReturnType<typeof logger>;
    let layer: IntegrationsLayer;

    beforeEach(async () => {
        UnreadableSecrets.reset();
        conf = layeredConfig(DEPLOYMENT);
        ({ cipher } = await keyringCipher(conf));
        log = logger();
        layer = new IntegrationsLayer(conf, cipher, log);
    });

    it("puts what the administrator set over the deployment's values, with the secrets decrypted, and leaves the rest to the deployment", () => {
        layer.apply(settingsRow(cipher, { giphy: { apiKey: "admin-giphy-key" }, dnsResolver: { mode: "doh-dnssec" }, stun: { urls: ["stun:stun.example.org:3478"] } }));

        expect(conf.get("giphy:api_key")).toBe("admin-giphy-key");
        expect(conf.get("mail:dns:resolver")).toBe("doh-dnssec");
        expect(conf.get("integrations:stun:urls")).toEqual(["stun:stun.example.org:3478"]);
        // Not set by the administrator: the deployment's.
        expect(conf.get("mail:dns:doh:endpoint")).toBe("https://doh.deployment.example/dns-query");
        expect(conf.get("mail:pki:signing_enrollment:backend")).toBe("manual");
    });

    it("applies a changed row without a restart, and puts a field back to the deployment's value once it is reset", () => {
        layer.apply(settingsRow(cipher, { version: 1, dnsResolver: { mode: "doh-dnssec", dohEndpoint: "https://doh.admin.example/dns-query" } }));
        expect(conf.get("mail:dns:resolver")).toBe("doh-dnssec");
        expect(conf.get("mail:dns:doh:endpoint")).toBe("https://doh.admin.example/dns-query");

        layer.apply(settingsRow(cipher, { version: 2, dnsResolver: { mode: "node" } }));
        expect(conf.get("mail:dns:resolver")).toBe("node");
        expect(conf.get("mail:dns:doh:endpoint")).toBe("https://doh.deployment.example/dns-query");

        layer.apply(undefined);
        expect(conf.get("mail:dns:resolver")).toBe("node");
        expect((conf as any).stores[INTEGRATIONS_STORE].store).toEqual({});
    });

    it("turns Giphy off by emptying its key as well as saying so, so a consumer that only reads the key stops using it", () => {
        layer.apply(settingsRow(cipher, { giphy: { enabled: false, apiKey: "admin-giphy-key" } }));
        expect(conf.get("giphy:enabled")).toBe(false);
        expect(conf.get("giphy:api_key")).toBe("");
    });

    it("sits directly below the plugin settings, and never writes the layer a plugin's settings are in", () => {
        const stores = Object.keys((conf as any).stores);
        expect(stores.indexOf(INTEGRATIONS_STORE)).toBe(stores.indexOf("plugins") + 1);
        layer.apply(settingsRow(cipher, { giphy: { apiKey: "admin-giphy-key" } }));
        expect((conf as any).stores.plugins.store).toEqual({});
    });

    it("reads the deployment's values from the configuration without the layer, even while the layer overrides them", () => {
        layer.apply(settingsRow(cipher, { giphy: { apiKey: "admin-giphy-key" }, dnsResolver: { mode: "doh-dnssec" } }));
        expect(layer.deploymentConfig()).toMatchObject({
            "giphy:api_key": "deployment-giphy-key",
            "mail:dns:resolver": "node",
            "mail:dns:doh:endpoint": "https://doh.deployment.example/dns-query",
            "system:plugins:registry": "https://registry.deployment.example",
        });
        // A key nothing configures is not in it.
        expect(layer.deploymentConfig()).not.toHaveProperty("integrations:stun:urls");
    });

    it("keeps the deployment's registry token with the deployment's registry, whatever the layer held before", () => {
        layer.apply(settingsRow(cipher, { version: 1, pluginRegistry: { url: "https://registry.admin.example" } }));
        // Another registry than the deployment's: the deployment's token must not go there.
        expect(conf.get("system:plugins:registry")).toBe("https://registry.admin.example");
        expect(conf.get("system:plugins:registry_token")).toBe("");

        // The same registry again: the deployment's token applies once more, from the deployment's config and not from what the layer held.
        layer.apply(settingsRow(cipher, { version: 2, pluginRegistry: { url: "https://registry.deployment.example/" } }));
        expect(conf.get("system:plugins:registry_token")).toBe("deployment-npm-token");
        layer.apply(settingsRow(cipher, { version: 3, pluginRegistry: { url: "https://registry.admin.example", token: "admin-npm-token" } }));
        expect(conf.get("system:plugins:registry_token")).toBe("admin-npm-token");
    });

    it("carries the plugin namespaces with their decrypted tokens", () => {
        layer.apply(settingsRow(cipher, { pluginRegistry: { namespaces: [{ name: "@acme", registry: "https://npm.acme.example", token: "acme-token" }, { name: "@open" }] } }));
        expect(conf.get("system:plugins:namespaces")).toEqual([{ name: "@acme", registry: "https://npm.acme.example", token: "acme-token" }, { name: "@open" }]);
    });

    describe("a secret that can't be read", () => {
        const elsewhere = async (): Promise<ConfigCipher> => {
            const other = layeredConfig({ config_encryption: { keyring: JSON.stringify(generateConfigKeyring()) } });
            return (await keyringCipher(other)).cipher;
        };

        it("is left out so the deployment's value applies, named once per field in a warning that never carries a value, and remembered for the console", async () => {
            const row = settingsRow(await elsewhere(), { giphy: { apiKey: "lost-giphy-key" }, pluginRegistry: { url: "https://registry.admin.example", token: "lost-npm-token" } });

            const result = layer.apply(row);
            expect([...result.unreadable].sort()).toEqual(["giphy.apiKey", "pluginRegistry.token"]);
            expect(conf.get("giphy:api_key")).toBe("deployment-giphy-key");
            // The registry URL is the administrator's own, the unreadable token is none, and the deployment's never goes there.
            expect(conf.get("system:plugins:registry_token")).toBe("");

            layer.apply({ ...row, version: 2 });
            const warnings = log.warn.mock.calls.map((call) => String(call[0]));
            expect(warnings.filter((message) => message.includes("giphy.apiKey"))).toHaveLength(1);
            expect(warnings.filter((message) => message.includes("pluginRegistry.token"))).toHaveLength(1);
            expect(warnings.join("\n")).not.toMatch(/lost-giphy-key|lost-npm-token|"ct"|"iv"/);

            // What the console reads (never decrypting for the request): this process tried and failed.
            expect(UnreadableSecrets.isUnreadable(integrationSecretContext("giphy.apiKey"), row.giphy.apiKey)).toBe(true);
            expect(UnreadableSecrets.isUnreadable(integrationSecretContext("pluginRegistry.token"), row.pluginRegistry.token)).toBe(true);
        });

        it("is read, and forgotten as unreadable, once it is entered again; the warning is given again if it later fails again", async () => {
            const lost = settingsRow(await elsewhere(), { version: 1, giphy: { apiKey: "lost-giphy-key" } });
            layer.apply(lost);
            expect(layer.unreadable).toEqual(["giphy.apiKey"]);

            const entered = settingsRow(cipher, { version: 2, giphy: { apiKey: "entered-again" } });
            expect(layer.apply(entered).unreadable).toEqual([]);
            expect(conf.get("giphy:api_key")).toBe("entered-again");
            expect(layer.unreadable).toEqual([]);
            expect(UnreadableSecrets.isUnreadable(integrationSecretContext("giphy.apiKey"), lost.giphy.apiKey)).toBe(false);

            layer.apply({ ...lost, version: 3 });
            expect(log.warn.mock.calls.filter((call) => String(call[0]).includes("giphy.apiKey"))).toHaveLength(2);
        });

        it("leaves a namespace on the list without its token", async () => {
            layer.apply(settingsRow(await elsewhere(), { pluginRegistry: { namespaces: [{ name: "@acme", registry: "https://npm.acme.example", token: "lost" }] } }));
            expect(conf.get("system:plugins:namespaces")).toEqual([{ name: "@acme", registry: "https://npm.acme.example" }]);
        });
    });

    it("keeps the layer it has when the row can't be applied: a failure that isn't about a secret is a bug and passes through", () => {
        layer.apply(settingsRow(cipher, { version: 1, giphy: { apiKey: "admin-giphy-key" } }));
        const row = settingsRow(cipher, { version: 2, giphy: { apiKey: "other" } });
        const decryptString = vi.spyOn(cipher, "decryptString").mockImplementation(() => {
            throw new TypeError("a bug");
        });
        expect(() => layer.apply(row)).toThrow("a bug");
        decryptString.mockRestore();
        expect(conf.get("giphy:api_key")).toBe("admin-giphy-key");
        expect(layer.version).toBe(1);
    });

    it("tells which row version it holds, none before the first", () => {
        expect(layer.version).toBeUndefined();
        layer.apply(settingsRow(cipher, { version: 7, giphy: { enabled: true } }));
        expect(layer.version).toBe(7);
        layer.apply(undefined);
        expect(layer.version).toBe(0);
    });

    it("refuses a configuration that has no integrations layer, since a layer added last would lose to the environment", () => {
        const plain = new nconf.Provider();
        plain.use("memory");
        expect(() => new IntegrationsLayer(plain, cipher, log)).toThrow(/integrations layer/);
    });
});
