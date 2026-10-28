///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
// How a server process takes up the integrations (spec 11.1, 11.2): the layer and `HostConfig` before the plugin host, the live sync once the datastores
// are connected.
import { HostConfig } from "@rapidmx/restapi";
import { RepoUtils } from "@rapidrest/service-core";
import { IntegrationsLayer } from "../../src/integrations/IntegrationsLayer.js";
import { LocalIntegrationsChannel } from "../../src/integrations/IntegrationsChannel.js";
import { prepareIntegrations, startIntegrationsSync } from "../../src/integrations/startIntegrations.js";
import { keyringCipher, layeredConfig, logger, settingsRow } from "../helpers/integrations.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("prepareIntegrations", () => {
    it("builds the layer and installs the configuration for HostConfig, so code that reads it at use time sees the layer", async () => {
        const conf = layeredConfig({ giphy: { api_key: "deployment-key" } });
        const { cipher } = await keyringCipher(conf);
        const integrations = prepareIntegrations(conf, cipher, logger());
        try {
            expect(HostConfig.isInstalled()).toBe(true);
            expect(IntegrationsLayer.active).toBe(integrations.layer);
            expect(HostConfig.get("giphy:api_key")).toBe("deployment-key");

            integrations.layer.apply(settingsRow(cipher, { giphy: { apiKey: "admin-key" } }));
            expect(HostConfig.get("giphy:api_key")).toBe("admin-key");
        } finally {
            integrations.stop();
        }
        expect(HostConfig.isInstalled()).toBe(false);
        expect(IntegrationsLayer.active).toBeUndefined();
    });

    it("installs the configuration once, as HostConfig requires", async () => {
        const conf = layeredConfig();
        const { cipher } = await keyringCipher(conf);
        const first = prepareIntegrations(conf, cipher, logger());
        try {
            expect(() => prepareIntegrations(conf, cipher, logger())).toThrow(/already/);
            // The failed attempt left the first one in place.
            expect(IntegrationsLayer.active).toBe(first.layer);
        } finally {
            first.stop();
        }
    });
});

describe("startIntegrationsSync", () => {
    let conf: ReturnType<typeof layeredConfig>;
    let cipher: Awaited<ReturnType<typeof keyringCipher>>["cipher"];
    let layer: IntegrationsLayer;
    let log: ReturnType<typeof logger>;
    let row: any;
    let channel: LocalIntegrationsChannel;
    let repo: { findOne: ReturnType<typeof vi.fn> };
    let factory: any;
    const settingsClass = class IntegrationSettingsDouble {};

    beforeEach(async () => {
        conf = layeredConfig({ giphy: { api_key: "deployment-key" } });
        ({ cipher } = await keyringCipher(conf));
        log = logger();
        layer = new IntegrationsLayer(conf, cipher, log);
        row = settingsRow(cipher, { version: 1, giphy: { apiKey: "key-1" } });
        channel = new LocalIntegrationsChannel();
        repo = { findOne: vi.fn(async () => row) };
        factory = {
            newInstance: vi.fn(async (type: unknown) => {
                if (type === RepoUtils) {
                    return repo;
                }
                if (type === "IntegrationsChannel") {
                    return channel;
                }
                throw new Error(`unexpected ${String(type)}`);
            }),
        };
    });

    it("applies the row, then follows the change notice and the row's version, reading the row as the route does", async () => {
        const running = await startIntegrationsSync(factory, layer, settingsClass, log, { pollMs: 40 });
        try {
            expect(conf.get("giphy:api_key")).toBe("key-1");
            expect(repo.findOne).toHaveBeenCalledWith("integrations", { ignoreACL: true, skipCache: true });
            expect(factory.newInstance).toHaveBeenCalledWith(RepoUtils, { name: "IntegrationSettingsDouble", args: [settingsClass] });

            row = settingsRow(cipher, { version: 2, giphy: { apiKey: "key-2" } });
            await channel.publish(2);
            await sleep(20);
            expect(conf.get("giphy:api_key")).toBe("key-2");

            row = settingsRow(cipher, { version: 3, giphy: { apiKey: "key-3" } });
            await sleep(100);
            expect(conf.get("giphy:api_key")).toBe("key-3");
        } finally {
            await running.stop();
        }
    });

    it("stays up on its timer alone when the notice channel can't be built, and says so", async () => {
        factory.newInstance.mockImplementation(async (type: unknown) => {
            if (type === RepoUtils) {
                return repo;
            }
            throw new Error("No class found with name: IntegrationsChannel");
        });
        const running = await startIntegrationsSync(factory, layer, settingsClass, log, { pollMs: 40 });
        try {
            expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("IntegrationsChannel"));
            row = settingsRow(cipher, { version: 2, giphy: { apiKey: "key-2" } });
            await sleep(100);
            expect(conf.get("giphy:api_key")).toBe("key-2");
        } finally {
            await running.stop();
        }
    });

    it("does not stop the server from starting when the row can't be read; the next tick tries again", async () => {
        repo.findOne.mockRejectedValueOnce(new Error("datastore down"));
        const running = await startIntegrationsSync(factory, layer, settingsClass, log, { pollMs: 40 });
        try {
            expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("datastore down"));
            await sleep(100);
            expect(conf.get("giphy:api_key")).toBe("key-1");
        } finally {
            await running.stop();
        }
    });

    it("does not stop the server from starting when the row's repository can't be built", async () => {
        factory.newInstance.mockRejectedValue(new Error("no datastore"));
        const running = await startIntegrationsSync(factory, layer, settingsClass, log, { pollMs: 40 });
        expect(log.error).toHaveBeenCalledWith(expect.stringContaining("no datastore"));
        await running.stop();
    });
});
