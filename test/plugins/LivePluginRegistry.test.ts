///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
// The plugin registry (spec 10.2, 11.3). The plugin route builds its registry clients from the integrations layer at each call. The plugin host does not: it
// installs before any of the server's datastores connect, from the deployment's registry alone, because the Integrations row's registry fields are plain and a
// database writer must not be able to move where the code this server runs is installed from.
import "reflect-metadata";
import { HostConfig, NpmRegistryClient, type Plugin } from "@rapidmx/restapi";
import { IntegrationsLayer } from "../../src/integrations/IntegrationsLayer.js";
import { prepareIntegrations } from "../../src/integrations/startIntegrations.js";
import { PluginHost } from "../../src/plugins/PluginHost.js";
import { PluginInstaller } from "../../src/plugins/PluginInstaller.js";
import { PluginStateStore } from "../../src/plugins/PluginStateStore.js";
import { withLivePluginRegistry } from "../../src/routes/livePluginRegistry.js";
import { keyringCipher, layeredConfig, logger, settingsRow } from "../helpers/integrations.js";

const DEPLOYMENT = { system: { plugins: { registry: "https://registry.deployment.example", registry_token: "deployment-token", namespaces: ["@rapidmx"] } } };

const clientOf = (client: NpmRegistryClient) => ({ url: (client as any).registryUrl as string, token: (client as any).authToken as string | undefined });

/** A store over an in-memory plugin table: it has no way to read the Integrations row, as the real one has none. */
class MemoryStore extends PluginStateStore {
    public seen: ((packageName: string) => NpmRegistryClient)[] = [];

    constructor() {
        super(undefined, logger(), "mongo", class {});
    }

    public async loadAndSeed(_defaults: any, registryFor: (packageName: string) => NpmRegistryClient): Promise<Plugin[]> {
        this.seen.push(registryFor);
        return [];
    }
}

describe("the plugin host and the integrations layer", () => {
    let conf: ReturnType<typeof layeredConfig>;
    let cipher: Awaited<ReturnType<typeof keyringCipher>>["cipher"];
    let factory: Awaited<ReturnType<typeof keyringCipher>>["factory"];
    let installerOptions: any[];

    beforeEach(async () => {
        conf = layeredConfig(DEPLOYMENT);
        ({ cipher, factory } = await keyringCipher(conf));
        installerOptions = [];
        vi.spyOn(PluginInstaller.prototype, "install").mockImplementation(async function (this: any) {
            installerOptions.push(this.options);
            return { installed: [], errors: [] };
        });
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        await factory.destroy();
    });

    it("installs from the deployment's registry, token and namespaces: the layer prepared for the server is empty until the datastores are connected", async () => {
        const integrations = prepareIntegrations(conf, cipher, logger());
        try {
            const store = new MemoryStore();
            await PluginHost.prepare({ config: conf, logger: logger(), datastore: "mongo", pluginClass: class {}, appRoot: process.cwd(), store } as any);

            expect(integrations.layer.version).toBeUndefined();
            expect(installerOptions[0]).toMatchObject({ registry: "https://registry.deployment.example", registryToken: "deployment-token", namespaces: [{ name: "@rapidmx" }] });
            expect(clientOf(store.seen[0]("@rapidmx/meet-plugin"))).toEqual({ url: "https://registry.deployment.example", token: "deployment-token" });
            // A row an administrator saved (here applied by hand, as the sync does once the datastores are connected) does not move what was already read.
            integrations.layer.apply(settingsRow(cipher, { pluginRegistry: { url: "https://registry.admin.example", token: "admin-token" } }));
            expect(clientOf(store.seen[0]("left-pad"))).toEqual({ url: "https://registry.deployment.example", token: "deployment-token" });
        } finally {
            integrations.stop();
        }
    });
});

describe("withLivePluginRegistry", () => {
    let conf: ReturnType<typeof layeredConfig>;
    let layer: IntegrationsLayer;
    let cipher: Awaited<ReturnType<typeof keyringCipher>>["cipher"];
    let uninstall: (() => void) | undefined;
    let route: any;

    class Base {
        public logger: any = logger();
        protected get namespaces() {
            return [{ name: "@startup" }];
        }
        protected get allowedPackages(): string[] {
            return [...this.namespaces.map((namespace: any) => `${namespace.name}/*`)];
        }
        protected createRegistryClient(_name?: string): NpmRegistryClient {
            return new NpmRegistryClient("https://registry.startup.example", "startup-token");
        }
    }

    beforeEach(async () => {
        conf = layeredConfig(DEPLOYMENT);
        ({ cipher } = await keyringCipher(conf));
        layer = new IntegrationsLayer(conf, cipher, logger());
        uninstall = HostConfig.install(conf);
        route = new (withLivePluginRegistry(Base as any))();
    });

    afterEach(() => uninstall?.());

    it("lists the namespaces in force at each call, and allows the packages in them", () => {
        expect(route.namespaces).toEqual([{ name: "@rapidmx" }]);
        layer.apply(settingsRow(cipher, { pluginRegistry: { namespaces: [{ name: "@acme", registry: "https://npm.acme.example", token: "acme-token" }] } }));
        expect(route.namespaces).toEqual([{ name: "@acme", registry: "https://npm.acme.example", token: "acme-token" }]);
        expect(route.allowedPackages).toEqual(["@acme/*"]);
    });

    it("creates registry clients for the registry, token and namespaces in force at each call", () => {
        expect(clientOf(route.createRegistryClient("@rapidmx/meet-plugin"))).toEqual({ url: "https://registry.deployment.example", token: "deployment-token" });

        layer.apply(
            settingsRow(cipher, {
                pluginRegistry: { url: "https://registry.admin.example", token: "admin-token", namespaces: [{ name: "@acme", registry: "https://npm.acme.example", token: "acme-token" }, { name: "@open", token: "open-token" }] },
            }),
        );
        // A namespace on its own registry never gets the default registry's token; one on the default registry uses its own.
        expect(clientOf(route.createRegistryClient("@acme/booking"))).toEqual({ url: "https://npm.acme.example", token: "acme-token" });
        expect(clientOf(route.createRegistryClient("@open/thing"))).toEqual({ url: "https://registry.admin.example", token: "open-token" });
        expect(clientOf(route.createRegistryClient("left-pad"))).toEqual({ url: "https://registry.admin.example", token: "admin-token" });
        expect(clientOf(route.createRegistryClient("@acme"))).toEqual({ url: "https://npm.acme.example", token: "acme-token" });
        expect(clientOf(route.createRegistryClient())).toEqual({ url: "https://registry.admin.example", token: "admin-token" });

        layer.apply(undefined);
        expect(clientOf(route.createRegistryClient("@rapidmx/meet-plugin"))).toEqual({ url: "https://registry.deployment.example", token: "deployment-token" });
    });

    it("keeps what the route was built with in a process with no host", () => {
        uninstall?.();
        uninstall = undefined;
        expect(route.namespaces).toEqual([{ name: "@startup" }]);
        expect(clientOf(route.createRegistryClient("left-pad"))).toEqual({ url: "https://registry.startup.example", token: "startup-token" });
    });
});
