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
import { ObjectFactory, RateLimiter, Server } from "@rapidrest/service-core";
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
import { TieredRateLimiter } from "../src/lib/TieredRateLimiter.js";
import { setDraining } from "../src/plugins/readiness.js";
import { freePort, localRequest } from "./helpers/serverTestUtils.js";

// No fixed port: a free one is picked when it starts, and the datastore URLs below point at it.
const mongod: MongoMemoryServer = new MongoMemoryServer({
    instance: {
        dbName: "mongomemory-rrst-test",
    },
});

describe("Server Tests", () => {
    const logger = new Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    // Mirrors the DI provider registration registerCoreProviders() (src/lib/registerCoreProviders.ts) applies for
    // src/worker.mongo.ts — this test builds its own Server rather than importing that entry point (it runs `void
    // start(...)` unconditionally at module load with no "only if this is the main module" guard - see
    // selectConfigDrivenBackend()'s own doc comment), so it must register the same @rapidmx/restapi string-token
    // dependencies itself or any route touching them (BlobStore/SearchProvider/SpamScanProvider/AvScanProvider/
    // MailTransport/DnsResolver/DkimKeyProvider) fails to instantiate.
    // Always LocalFsBlobStore here, even though worker.mongo.ts's real registration is config-driven
    // (mail:blob:backend) - a test run has no business making live network S3 calls.
    objectFactory.register(LocalFsBlobStore, "BlobStore");
    objectFactory.register(MongoTextSearchProvider, "SearchProvider");
    objectFactory.register(RspamdSpamScanProvider, "SpamScanProvider");
    objectFactory.register(ClamAvScanProvider, "AvScanProvider");
    objectFactory.register(PostfixSendmailTransport, "MailTransport");
    // Always NodeDnsResolver here, even though worker.mongo.ts's real registration is config-driven
    // (mail:dns:resolver) - a test run has no business making live network DoH queries, and nothing this
    // suite exercises depends on DNSSEC validation actually happening.
    objectFactory.register(NodeDnsResolver, "DnsResolver");
    objectFactory.register(FsDkimKeyProvider, "DkimKeyProvider");
    // Mirrors worker.mongo.ts's config-driven CA backend selection (mail:pki:backend) - not currently
    // exercised by any mounted route/test, but kept in sync so registering a KeyVault-style route later
    // doesn't hit a "no class found with name: EncryptionCertificateAuthority" surprise here.
    const caBackend: string = config.get("mail:pki:backend") || "local";
    objectFactory.register(
        caBackend === "openbao" ? OpenBaoPkiCertificateAuthority : LocalX509CertificateAuthority,
        "EncryptionCertificateAuthority"
    );
    // Always ManualSigningCertificateEnrollment here, even though worker.mongo.ts's real registration is
    // config-driven (mail:pki:signing_enrollment:backend) - a test run has no business making live ACME
    // network calls against a real certificate authority.
    objectFactory.register(ManualSigningCertificateEnrollment, "SigningCertificateEnrollment");
    objectFactory.register(TieredRateLimiter, "RateLimiter");
    let server: Server;
    let port: number;

    beforeAll(async () => {
        await mongod.start();
        for (const name of ["acl", "mongo"]) {
            config.set(`datastores:${name}:url`, mongod.getUri());
        }
        // A free port on 127.0.0.1 rather than the default 3000, which a running `yarn dev` server may already hold.
        port = await freePort();
        config.set("port", port);
        config.set("listen_host", "127.0.0.1");
        server = new Server({ config, basePath: "./src/mongo", logger, objectFactory });
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
        let result = await localRequest(port, "OPTIONS", "/", { Origin: corsOrigins[0] });
        expect(result.headers["access-control-allow-origin"]).toEqual(corsOrigins[0]);
        result = await localRequest(port, "OPTIONS", "/", { Origin: "http://localhost:3005" });
        expect(result.headers["access-control-allow-origin"]).not.toBeDefined();
    });

    it("Reports not ready while draining for a plugin restart, and rate limits with TieredRateLimiter.", async () => {
        expect((await localRequest(port, "GET", "/api/status")).status).toBe(200);
        setDraining(true);
        try {
            expect((await localRequest(port, "GET", "/api/status")).status).toBe(503);
        } finally {
            setDraining(false);
        }
        expect((await localRequest(port, "GET", "/api/status")).status).toBe(200);
        expect(await objectFactory.newInstance(RateLimiter, { name: "default" })).toBeInstanceOf(TieredRateLimiter);
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
