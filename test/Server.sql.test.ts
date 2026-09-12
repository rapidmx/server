///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2020-2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
vi.mock("redis", async () => {
    const { createFakeRedisModule } = await import("./helpers/FakeRedis.js");
    return createFakeRedisModule();
});

const corsOrigins = ["http://localhost:3000", "http://localhost:3001", "http://localhost:3002"];
process.env[`cors__origins`] = JSON.stringify(corsOrigins);

import config from "../src/config.sql.js";
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
import { PostgresFullTextSearchProvider } from "@rapidmx/restapi/search";
import { ClamAvScanProvider, RspamdSpamScanProvider } from "@rapidmx/restapi/scan";
import * as fs from "fs";
import * as sqlite3 from "sqlite3";

const sqlite: sqlite3.Database = new sqlite3.Database(":memory:");

// The "acl" and "sql" datastores each open their own native connection - better-sqlite3 (unlike the
// old `sqlite3`-backed "sqlite" driver) takes an exclusive lock on every write, so two connections
// sharing one file collide with a "database is locked" error the moment their startup schema syncs
// overlap. Giving each its own file sidesteps that; ACL and SQL storage don't need to be colocated.
const SQL_DB_FILE = "rrst-test";
const ACL_DB_FILE = "rrst-test-acl";

describe("Server Tests", () => {
    const logger = new Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    // Mirrors the DI provider registration in src/server.sql.ts — this test builds its own Server rather
    // than importing that script, so it must register the same @rapidmx/restapi string-token dependencies
    // itself or any route touching them (BlobStore/SearchProvider/SpamScanProvider/AvScanProvider/
    // MailTransport/DnsResolver/DkimKeyProvider) fails to instantiate.
    // Always LocalFsBlobStore here, even though server.sql.ts's real registration is config-driven
    // (mail:blob:backend) - a test run has no business making live network S3 calls.
    objectFactory.register(LocalFsBlobStore, "BlobStore");
    objectFactory.register(PostgresFullTextSearchProvider, "SearchProvider");
    objectFactory.register(RspamdSpamScanProvider, "SpamScanProvider");
    objectFactory.register(ClamAvScanProvider, "AvScanProvider");
    objectFactory.register(PostfixSendmailTransport, "MailTransport");
    // Always NodeDnsResolver here, even though server.sql.ts's real registration is config-driven
    // (mail:dns:resolver) - a test run has no business making live network DoH queries, and nothing this
    // suite exercises depends on DNSSEC validation actually happening.
    objectFactory.register(NodeDnsResolver, "DnsResolver");
    objectFactory.register(FsDkimKeyProvider, "DkimKeyProvider");
    // Mirrors server.sql.ts's config-driven CA backend selection (mail:pki:backend) - not currently
    // exercised by any mounted route/test, but kept in sync so registering a KeyVault-style route later
    // doesn't hit a "no class found with name: EncryptionCertificateAuthority" surprise here.
    const caBackend: string = config.get("mail:pki:backend") || "local";
    objectFactory.register(
        caBackend === "openbao" ? OpenBaoPkiCertificateAuthority : LocalX509CertificateAuthority,
        "EncryptionCertificateAuthority"
    );
    objectFactory.register(ManualSigningCertificateEnrollment, "SigningCertificateEnrollment");
    const server: Server = new Server({ config, basePath: "./src/sql", logger, objectFactory });

    beforeAll(async () => {
        config.set("datastores:acl", {
            type: "better-sqlite3",
            host: "localhost",
            database: ACL_DB_FILE,
            synchronize: true,
        });
        config.set("datastores:sql", {
            type: "better-sqlite3",
            host: "localhost",
            database: SQL_DB_FILE,
            synchronize: true,
        });
    });

    afterAll(async () => {
        await new Promise<void>((resolve) => {
            sqlite.close((err) => {
                if (err) {
                    throw new Error(err.message);
                }
                resolve();
            });
        });
        for (const file of [SQL_DB_FILE, ACL_DB_FILE]) {
            await fs.promises.rm(file, { force: true });
        }
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
