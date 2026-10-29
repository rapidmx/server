///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
// What a server does before it listens: the Integrations an administrator chose are in force from the first request of a start (a DNS
// resolver of doh-dnssec that has not been applied yet is Node's, which does not validate), then the installation's setup.
import { NodeDnsResolver } from "@rapidmx/restapi";
import { RepoUtils } from "@rapidrest/service-core";
import { DelegatingDnsResolver } from "../../src/dns/DelegatingDnsResolver.js";
import { DohDnssecDnsResolver } from "../../src/dns/DohDnssecDnsResolver.js";
import { IntegrationsLayer } from "../../src/integrations/IntegrationsLayer.js";
import { prepareIntegrations, type PreparedIntegrations } from "../../src/integrations/startIntegrations.js";
import { InstallationServer } from "../../src/lib/InstallationServer.js";
import { prepareInstallation } from "../../src/lib/prepareInstallation.js";
import { keyringCipher, layeredConfig, logger, settingsRow } from "../helpers/integrations.js";

class IntegrationSettingsDouble {}
class DnsProviderDouble {}
class DomainDouble {}
class SetupStateDouble {}
class AuditLogDouble {}
class DomainSeederDouble {
    public domains: unknown = undefined;
}
const classes = () => ({ dnsProviderClass: DnsProviderDouble, domainClass: DomainDouble, setupStateClass: SetupStateDouble, auditLogClass: AuditLogDouble, domainSeederClass: DomainSeederDouble });

describe("prepareInstallation", () => {
    let conf: ReturnType<typeof layeredConfig>;
    let cipher: Awaited<ReturnType<typeof keyringCipher>>["cipher"];
    let prepared: PreparedIntegrations;
    let log: ReturnType<typeof logger>;
    let events: string[];
    let row: any;
    let findOne: ReturnType<typeof vi.fn>;
    let factory: { newInstance: ReturnType<typeof vi.fn> };

    beforeEach(async () => {
        conf = layeredConfig({ mail: { dns: { resolver: "node" } } });
        ({ cipher } = await keyringCipher(conf));
        log = logger();
        prepared = prepareIntegrations(conf, cipher, log);
        events = [];
        row = settingsRow(cipher, { version: 4, dnsResolver: { mode: "doh-dnssec" } });
        findOne = vi.fn(async () => {
            events.push("row read");
            return row;
        });
        factory = {
            newInstance: vi.fn(async (type: any, options: any = {}) => {
                if (type === RepoUtils) {
                    return options.args[0] === IntegrationSettingsDouble ? { findOne } : { findOne: async () => undefined, create: async (value: any) => value, update: async (value: any) => value };
                }
                if (type === DomainSeederDouble) {
                    return {
                        run: async () => {
                            events.push("seeder");
                            return { created: [], recorded: [], skipped: 0, adopted: [] };
                        },
                    };
                }
                // No cipher, no audit, no publisher: the installation has no DNS provider to create, which is not what this is about.
                throw new Error(`no ${String(type?.name ?? type)}`);
            }),
        };
    });

    afterEach(() => prepared.stop());

    const integrations = () => ({ layer: prepared.layer, settingsClass: IntegrationSettingsDouble });

    it("has the administrator's resolver in force in the step before the server listens, so a lookup of the first request is validated", async () => {
        let resolverInStep: unknown;
        const server = new InstallationServer({ config: { get: () => undefined }, logger: log, classLoader: {} as any, objectFactory: {} as any }, async () => {
            await prepareInstallation(factory, conf, log, classes(), integrations());
            resolverInStep = conf.get("mail:dns:resolver");
        });
        await (server as any).postStart();

        expect(resolverInStep).toBe("doh-dnssec");
        const delegating = new DelegatingDnsResolver();
        const node = new NodeDnsResolver();
        const doh = new DohDnssecDnsResolver();
        const viaNode = vi.spyOn(node, "resolveTxt").mockResolvedValue([["from-node"]]);
        const viaDoh = vi.spyOn(doh, "resolveTxt").mockResolvedValue([["from-doh"]]);
        (delegating as any).node = node;
        (delegating as any).doh = doh;
        (delegating as any).configuredMode = "node";
        // HostConfig reads the same configuration the layer was applied to.
        const { HostConfig } = await import("@rapidmx/restapi");
        expect(HostConfig.get("mail:dns:resolver")).toBe("doh-dnssec");
        await expect(delegating.resolveTxt("example.com")).resolves.toEqual([["from-doh"]]);
        expect(viaNode).not.toHaveBeenCalled();
        expect(viaDoh).toHaveBeenCalledTimes(1);
    });

    it("applies the integrations before the installation's setup, which reads nothing of them but must not run on the deployment's values either", async () => {
        await prepareInstallation(factory, conf, log, classes(), integrations());
        expect(events).toEqual(["row read", "seeder"]);
    });

    it("leaves the layer for startIntegrationsSync() to fill when the row can't be read, after trying again, and still does the installation's setup", async () => {
        findOne.mockRejectedValue(new Error("datastore down"));
        const done = prepareInstallation(factory, conf, log, classes(), integrations());
        await expect(done).resolves.toBeDefined();
        expect(findOne.mock.calls.length).toBeGreaterThan(1);
        expect(conf.get("mail:dns:resolver")).toBe("node");
        expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("datastore down"));
        expect(events).toContain("seeder");
    }, 10_000);

    it("holds the layer's row the sync reads next as already applied, so the first read of startIntegrationsSync() changes nothing", async () => {
        await prepareInstallation(factory, conf, log, classes(), integrations());
        expect(prepared.layer.version).toBe(4);
        expect(IntegrationsLayer.active).toBe(prepared.layer);
    });
});
