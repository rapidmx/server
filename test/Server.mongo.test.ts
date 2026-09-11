///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2020-2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
vi.mock("redis", async () => {
    const { createFakeRedisModule } = await import("./helpers/FakeRedis.js");
    return createFakeRedisModule();
});

const corsOrigins = ["http://localhost:3000", "http://localhost:3001", "http://localhost:3002"];
process.env[`cors__origins`] = JSON.stringify(corsOrigins);

import config from "../src/config.mongo.js";
import { MongoMemoryServer } from "mongodb-memory-server";
import { Logger, sleep } from "@rapidrest/core";
import { ObjectFactory, Server } from "@rapidrest/service-core";
import { request } from "@rapidrest/service-core/test";
import {
    FsDkimKeyProvider,
    LocalFsBlobStore,
    LocalX509CertificateAuthority,
    ManualSigningCertificateEnrollment,
    NodeDnsResolver,
    OpenBaoPkiCertificateAuthority,
    PostfixSendmailTransport,
} from "@rapidmx/restapi";
import { MongoTextSearchProvider } from "@rapidmx/restapi/search";
import { ClamAvScanProvider, RspamdSpamScanProvider } from "@rapidmx/restapi/scan";

const mongod: MongoMemoryServer = new MongoMemoryServer({
    instance: {
        port: 9999,
        dbName: "mongomemory-rrst-test",
    },
});

describe("Server Tests", () => {
    const logger = new Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    // Mirrors the DI provider registration in src/server.mongo.ts — this test builds its own Server rather
    // than importing that script, so it must register the same @rapidmx/restapi string-token dependencies
    // itself or any route touching them (BlobStore/SearchProvider/SpamScanProvider/AvScanProvider/
    // MailTransport/DnsResolver/DkimKeyProvider) fails to instantiate.
    objectFactory.register(LocalFsBlobStore, "BlobStore");
    objectFactory.register(MongoTextSearchProvider, "SearchProvider");
    objectFactory.register(RspamdSpamScanProvider, "SpamScanProvider");
    objectFactory.register(ClamAvScanProvider, "AvScanProvider");
    objectFactory.register(PostfixSendmailTransport, "MailTransport");
    objectFactory.register(NodeDnsResolver, "DnsResolver");
    objectFactory.register(FsDkimKeyProvider, "DkimKeyProvider");
    // Mirrors server.mongo.ts's config-driven CA backend selection (mail:pki:backend) - not currently
    // exercised by any mounted route/test, but kept in sync so registering a KeyVault-style route later
    // doesn't hit a "no class found with name: EncryptionCertificateAuthority" surprise here.
    const caBackend: string = config.get("mail:pki:backend") || "local";
    objectFactory.register(
        caBackend === "openbao" ? OpenBaoPkiCertificateAuthority : LocalX509CertificateAuthority,
        "EncryptionCertificateAuthority"
    );
    objectFactory.register(ManualSigningCertificateEnrollment, "SigningCertificateEnrollment");
    const server: Server = new Server({ config, basePath: "./src/mongo", logger, objectFactory });

    beforeAll(async () => {
        await mongod.start();
    });

    afterAll(async () => {
        await mongod.stop();
    });

    beforeEach(async () => {
        expect(server).toBeInstanceOf(Server);
        await server.start();
        // Wait a bit longer each time. This allows objects to finish initialization before we proceed.
        await sleep(1000);
    });

    afterEach(async () => {
        await server.stop();
    });

    it("Can start server.", async () => {
        expect(server.isRunning()).toBe(true);
        // Cors Check
        let result = await request(server).options("/").set("Origin", corsOrigins[0]);
        expect(result.headers["access-control-allow-origin"]).toEqual(corsOrigins[0]);
        result = await request(server).options("/").set("Origin", "http://localhost:3005");
        expect(result.headers["access-control-allow-origin"]).not.toBeDefined();
    });

    it("Can stop server.", async () => {
        expect(server.isRunning()).toBe(true);
        await server.stop();
        expect(server.isRunning()).toBe(false);
    });

    it("Can restart server.", async () => {
        expect(server.isRunning()).toBe(true);
        await server.restart();
        expect(server.isRunning()).toBe(true);
    });
});
