///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
// A real server on MongoDB doing its installation's setup: the installer's DNS provider config from mail:dns:bootstrap_provider and the mounted Secret, then the
// domains of mail:domains, before it listens (restapi spec 12.1, 13.3).
vi.mock("redis", async () => {
    const { createFakeRedisModule } = await import("../helpers/FakeRedis.js");
    return createFakeRedisModule();
});

import config from "../../src/config.mongo.js";
import { MongoMemoryServer } from "mongodb-memory-server";
import { Logger, sleep } from "@rapidrest/core";
import { ObjectFactory, RepoUtils } from "@rapidrest/service-core";
import { ConfigCipherMongo } from "@rapidmx/restapi/mongo";
import { MongoTextSearchProvider } from "@rapidmx/restapi/search";
import { AuditAction } from "@rapidmx/restapi";
import { DevLocalDeliveryTransportMongo } from "../../src/dev/DevLocalDeliveryTransportMongo.js";
import { InstallationServer } from "../../src/lib/InstallationServer.js";
import { MONGO_INSTALLATION } from "../../src/lib/installation/mongo.js";
import { registerCoreProviders } from "../../src/lib/registerCoreProviders.js";
import { seedInstallation } from "../../src/lib/seedInstallation.js";
import {
    bootstrapToken,
    BOOTSTRAP_TOKEN,
    configureInstallation,
    deleteInstallerProvider,
    installationFixture,
    installationRows,
    setupStateRow,
    type InstallationFixture,
} from "../helpers/installation.js";
import { freePort, localRequest } from "../helpers/serverTestUtils.js";

describe("the installation's setup on a real MongoDB server", () => {
    const logger = new Logger("warn");
    const mongod: MongoMemoryServer = new MongoMemoryServer({ instance: { dbName: "mongomemory-installation-test" } });
    let fixture: InstallationFixture;
    let objectFactory: ObjectFactory;
    let server: InstallationServer;
    let port: number;
    /** Whether the server was listening when the setup ran. */
    let listeningDuringSetup: boolean | undefined;

    beforeAll(async () => {
        await mongod.start();
        for (const name of ["acl", "mongo"]) {
            config.set(`datastores:${name}:url`, mongod.getUri());
        }
        fixture = installationFixture();
        configureInstallation(config, fixture);
        port = await freePort();
        config.set("port", port);
        config.set("listen_host", "127.0.0.1");
        objectFactory = new ObjectFactory(config, logger);
        registerCoreProviders(objectFactory, config, {
            searchProvider: MongoTextSearchProvider,
            configCipher: ConfigCipherMongo,
            devDeliveryTransport: DevLocalDeliveryTransportMongo,
            environment: "development",
        });
        // The same expression the worker builds its server with, and a look at whether the server listened yet.
        server = new InstallationServer({ config, basePath: "./src/mongo", logger, objectFactory }, async () => {
            listeningDuringSetup = server.isRunning();
            return seedInstallation(objectFactory, config, logger, MONGO_INSTALLATION);
        });
        await server.start();
        await sleep(500);
    }, 120_000);

    afterAll(async () => {
        await server?.stop();
        await mongod.stop();
        fixture.remove();
    });

    it("sets the installation up before the server listens, so it is ready only with its domains in place", async () => {
        expect(listeningDuringSetup).toBe(false);
        expect((await localRequest(port, "GET", "/api/status")).status).toBe(200);
    });

    it("creates the installer's DNS provider config once, its credentials encrypted for its row", async () => {
        const { providers } = await installationRows(objectFactory, MONGO_INSTALLATION);
        expect(providers).toHaveLength(1);
        const provider = providers[0];
        expect(provider).toMatchObject({
            name: "Installer Cloudflare",
            type: "cloudflare",
            zones: ["example.com"],
            options: { zoneIds: ["0123456789abcdef0123456789abcdef"] },
            origin: "installer",
            enabled: true,
            allowTakeover: false,
            credentialsGeneration: 1,
        });
        expect(JSON.stringify(provider)).not.toContain(BOOTSTRAP_TOKEN);
        expect(await bootstrapToken(objectFactory, provider)).toBe(BOOTSTRAP_TOKEN);
    });

    it("records on the setup row that it created the config, so that deleting it in the console is final", async () => {
        const { providers } = await installationRows(objectFactory, MONGO_INSTALLATION);
        expect((await setupStateRow(objectFactory, MONGO_INSTALLATION)).bootstrapDnsProviderUid).toBe(providers[0].uid);
    });

    it("seeds the installation's domains, the ones that name the installer's provider assigned to it when its zones cover them", async () => {
        const { providers, domains } = await installationRows(objectFactory, MONGO_INSTALLATION);
        const byName = Object.fromEntries(domains.map((domain) => [domain.name, domain]));
        expect(Object.keys(byName).sort()).toEqual(["example.com", "other.org", "shop.example.com"]);
        expect(byName["example.com"]).toMatchObject({ origin: "seed", verified: false });
        expect(byName["example.com"].dnsProviderUid ?? null).toBeNull();
        expect(byName["shop.example.com"]).toMatchObject({ origin: "seed", dnsProviderUid: providers[0].uid });
        // other.org is outside the provider's zones: created manual.
        expect(byName["other.org"].dnsProviderUid ?? null).toBeNull();
        // The DKIM key each domain got is on the volume the MTA reads.
        expect(byName["example.com"].dkimSelector).toBeTruthy();
    });

    it("audits the provider's creation without a user or a credential", async () => {
        const { providers, audit } = await installationRows(objectFactory, MONGO_INSTALLATION);
        const entries = audit.filter((entry) => entry.action === AuditAction.DNS_PROVIDER_CREATE);
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({ targetType: "DnsProvider", targetUid: providers[0].uid });
        expect(entries[0].actorUserUid ?? null).toBeNull();
        expect(JSON.stringify(entries[0])).not.toContain(BOOTSTRAP_TOKEN);
    });

    it("is idempotent: running it again on the next start creates and changes nothing", async () => {
        const before = await installationRows(objectFactory, MONGO_INSTALLATION);
        const again = await seedInstallation(objectFactory, config, logger, MONGO_INSTALLATION);
        expect(again.dnsProvider.status).toBe("exists");
        expect(again.domains).toMatchObject({ created: [] });
        const after = await installationRows(objectFactory, MONGO_INSTALLATION);
        expect(after.providers).toHaveLength(1);
        expect(after.providers[0].version).toBe(before.providers[0].version);
        expect(after.domains.map((domain) => [domain.name, domain.version])).toEqual(before.domains.map((domain) => [domain.name, domain.version]));
        expect(after.audit.filter((entry) => entry.action === AuditAction.DNS_PROVIDER_CREATE)).toHaveLength(1);
    });

    it("creates the config once when two server copies start together: the unique name makes the loser take the winner's as the one there", async () => {
        // A fresh installation: the config of the first start and the record of it are removed, then two copies run the setup at the same moment.
        await deleteInstallerProvider(objectFactory, MONGO_INSTALLATION, { forget: true });
        expect((await installationRows(objectFactory, MONGO_INSTALLATION)).providers).toHaveLength(0);

        const results = await Promise.all([seedInstallation(objectFactory, config, logger, MONGO_INSTALLATION), seedInstallation(objectFactory, config, logger, MONGO_INSTALLATION)]);
        const statuses = results.map((result) => result.dnsProvider.status).sort();
        expect(statuses.filter((status) => status === "created")).toHaveLength(1);
        expect(statuses.filter((status) => status === "failed")).toHaveLength(0);
        const { providers } = await installationRows(objectFactory, MONGO_INSTALLATION);
        expect(providers).toHaveLength(1);
        expect((await setupStateRow(objectFactory, MONGO_INSTALLATION)).bootstrapDnsProviderUid).toBe(providers[0].uid);
    });

    it("does not bring the config back after the administrator deleted it in the console, at the next start of any copy", async () => {
        await deleteInstallerProvider(objectFactory, MONGO_INSTALLATION);
        const again = await Promise.all([seedInstallation(objectFactory, config, logger, MONGO_INSTALLATION), seedInstallation(objectFactory, config, logger, MONGO_INSTALLATION)]);
        expect(again.map((result) => result.dnsProvider.status)).toEqual(["exists", "exists"]);
        const { providers, audit } = await installationRows(objectFactory, MONGO_INSTALLATION);
        expect(providers).toHaveLength(0);
        expect(audit.filter((entry) => entry.action === AuditAction.DNS_PROVIDER_CREATE)).toHaveLength(2);
    });
});
