///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
// The server's Integrations route (spec 10.2, 11.2): a saved change is announced to every copy, the deployment's values it shows as defaults exclude the
// integrations layer, and a secret the process could not read is marked "set, but can't be read" in the view (never by decrypting for the request).
import "reflect-metadata";
import { ConfigCipher, generateConfigKeyring } from "@rapidmx/restapi";
import { IntegrationsLayer } from "../../src/integrations/IntegrationsLayer.js";
import { LocalIntegrationsChannel } from "../../src/integrations/IntegrationsChannel.js";
import { IntegrationsRoute as IntegrationsRouteMongo } from "../../src/mongo/routes/IntegrationsRoute.js";
import { IntegrationsRoute as IntegrationsRouteSql } from "../../src/sql/routes/IntegrationsRoute.js";
import { UnreadableSecrets } from "../../src/secrets/UnreadableSecrets.js";
import { keyringCipher, layeredConfig, logger, settingsRow } from "../helpers/integrations.js";

describe.each([
    ["mongo", IntegrationsRouteMongo],
    ["sql", IntegrationsRouteSql],
])("%s IntegrationsRoute", (_name, routeClass) => {
    let conf: ReturnType<typeof layeredConfig>;
    let cipher: ConfigCipher;
    let elsewhere: ConfigCipher;
    let layer: IntegrationsLayer;
    let route: any;
    let row: any;

    beforeEach(async () => {
        UnreadableSecrets.reset();
        IntegrationsLayer.active = undefined;
        conf = layeredConfig({ giphy: { api_key: "deployment-key" }, mail: { dns: { resolver: "node" } } });
        ({ cipher } = await keyringCipher(conf));
        elsewhere = (await keyringCipher(layeredConfig({ config_encryption: { keyring: JSON.stringify(generateConfigKeyring()) } }))).cipher;
        layer = new IntegrationsLayer(conf, cipher, logger());
        route = new routeClass();
        route.cipher = cipher;
        row = undefined;
        route.repo = { findOne: async () => row };
    });

    afterEach(() => {
        IntegrationsLayer.active = undefined;
    });

    it("is mounted at system/integrations", () => {
        expect(Reflect.getMetadata("rrst:routePaths", routeClass.prototype)).toContain("/api/system/integrations");
    });

    describe("integrationsChanged()", () => {
        it("tells every copy the version the change left, through the channel", async () => {
            const channel = new LocalIntegrationsChannel();
            const heard: number[] = [];
            await channel.subscribe((version) => heard.push(version));
            route.channel = channel;
            await route.integrationsChanged({ version: 4 });
            expect(heard).toEqual([4]);
        });

        it("lets a failure to announce reach the base route, which logs it and still answers the request", async () => {
            route.channel = { publish: async () => Promise.reject(new Error("events redis down")), subscribe: async () => async () => undefined };
            await expect(route.integrationsChanged({ version: 4 })).rejects.toThrow(/events redis down/);
        });
    });

    describe("deploymentConfig()", () => {
        it("is the deployment's own values, not the layer's, once the server has built the layer", () => {
            layer.apply(settingsRow(cipher, { giphy: { apiKey: "admin-key" }, dnsResolver: { mode: "doh-dnssec" } }));
            IntegrationsLayer.active = layer;
            expect(route.deploymentConfig()).toMatchObject({ "giphy:api_key": "deployment-key", "mail:dns:resolver": "node" });
        });

        it("is what the route was built with in a process with no layer", () => {
            route.configGiphyApiKey = "built-with";
            expect(route.deploymentConfig()).toMatchObject({ "giphy:api_key": "built-with" });
        });
    });

    describe("the view of a secret that can't be read", () => {
        const view = async () => route.get();

        it("marks a secret this process failed to decrypt, and leaves a readable one and the deployment's defaults alone", async () => {
            IntegrationsLayer.active = layer;
            row = settingsRow(elsewhere, { giphy: { apiKey: "secret-giphy-value" }, pluginRegistry: { url: "https://registry.admin.example", token: "secret-token-value" } });
            // The tokens of the namespaces: one readable, one not (two different keyrings sealed them).
            const readable = settingsRow(cipher, { pluginRegistry: { namespaces: [{ name: "@ok", registry: "https://npm.ok.example", token: "secret-ok-value" }] } });
            row.pluginRegistry.namespaces = [...readable.pluginRegistry.namespaces, ...settingsRow(elsewhere, { pluginRegistry: { namespaces: [{ name: "@lost", registry: "https://npm.lost.example", token: "secret-ns-value" }] } }).pluginRegistry.namespaces];

            // restapi's view never decrypts: nothing has tried yet, so (with every kid unknown to this cipher) the key check is what marks them.
            layer.apply(row);
            const shown = await view();

            expect(shown.giphy.values.apiKey).toEqual({ secret: true, unreadable: true });
            expect(shown.pluginRegistry.values.token).toEqual({ secret: true, unreadable: true });
            expect(shown.pluginRegistry.values.namespaces).toEqual([
                { name: "@ok", registry: "https://npm.ok.example", token: { secret: true } },
                { name: "@lost", registry: "https://npm.lost.example", token: { secret: true, unreadable: true } },
            ]);
            // What the deployment configures is no envelope and is never marked.
            expect(JSON.stringify(shown.giphy.defaults)).not.toMatch(/unreadable/);
            expect(JSON.stringify(shown)).not.toMatch(/secret-[a-z]+-value|"ct"|"iv"|"tag"/);
        });

        it("marks a secret whose key this copy has not loaded without anything having been tried", async () => {
            row = settingsRow(elsewhere, { giphy: { apiKey: "lost" } });
            expect((await view()).giphy.values.apiKey).toEqual({ secret: true, unreadable: true });
        });

        it("marks a secret that failed to decrypt although its key is loaded (an envelope copied to another field), in the copy that tried", async () => {
            row = settingsRow(cipher, { giphy: { apiKey: "moved" } });
            // The same envelope under the registry token's name: it won't decrypt there.
            row.pluginRegistry = { token: row.giphy.apiKey };
            IntegrationsLayer.active = layer;
            layer.apply(row);
            const shown = await view();
            expect(shown.giphy.values.apiKey).toEqual({ secret: true });
            expect(shown.pluginRegistry.values.token).toEqual({ secret: true, unreadable: true });
        });

        it("forgets it once the secret is entered again, which is a new envelope", async () => {
            row = settingsRow(elsewhere, { version: 1, giphy: { apiKey: "lost" } });
            IntegrationsLayer.active = layer;
            layer.apply(row);
            expect((await view()).giphy.values.apiKey).toEqual({ secret: true, unreadable: true });
            row = settingsRow(cipher, { version: 2, giphy: { apiKey: "entered" } });
            layer.apply(row);
            expect((await view()).giphy.values.apiKey).toEqual({ secret: true });
        });

        it("shows a plain mask for every secret when the server registers no cipher", async () => {
            route.cipher = undefined;
            row = settingsRow(elsewhere, { giphy: { apiKey: "lost" } });
            expect((await view()).giphy.values.apiKey).toEqual({ secret: true });
        });

        it("leaves a view with no secrets as restapi made it", async () => {
            row = settingsRow(cipher, { stun: { urls: ["stun:stun.example.org:3478"] } });
            const shown = await view();
            expect(shown.stun.values.urls).toEqual(["stun:stun.example.org:3478"]);
            expect(shown.version).toBe(1);
        });
    });
});
