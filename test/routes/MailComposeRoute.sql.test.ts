///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
// MailComposeRoute against a real SQL datastore (better-sqlite3; see helpers/composeSendStamp.ts for what is checked).
vi.mock("redis", async () => {
    const { createFakeRedisModule } = await import("../helpers/FakeRedis.js");
    return createFakeRedisModule();
});

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import config from "../../src/config.sql.js";
import { Logger, sleep } from "@rapidrest/core";
import { ObjectFactory, Server } from "@rapidrest/service-core";
import { LocalFsBlobStore, NodeDnsResolver, ManualSigningCertificateEnrollment } from "@rapidmx/restapi";
import { FolderSQL, MailboxSQL, MessageSQL } from "@rapidmx/restapi/sql";
import { PostgresFullTextSearchProvider } from "@rapidmx/restapi/search";
import { DevLocalDeliveryTransportSQL } from "../../src/dev/DevLocalDeliveryTransportSQL.js";
import { registerCoreProviders } from "../../src/lib/registerCoreProviders.js";
import { MailComposeRoute } from "../../src/sql/routes/MailComposeRoute.js";
import { defineComposeSendStampTests } from "../helpers/composeSendStamp.js";
import { freePort } from "../helpers/serverTestUtils.js";

describe("MailComposeRoute (SQL)", () => {
    const logger = new Logger("warn");
    // Each datastore its own file: better-sqlite3 locks on every write (see Server.sql.test.ts).
    const dir: string = fs.mkdtempSync(path.join(os.tmpdir(), "rmx-compose-sql-"));
    const objectFactory = new ObjectFactory(config, logger);
    let server: Server;

    beforeAll(async () => {
        for (const name of ["acl", "sql"]) {
            config.set(`datastores:${name}`, { type: "better-sqlite3", host: "localhost", database: path.join(dir, name), synchronize: true });
        }
        config.set("mail:blob:local:root", path.join(dir, "blobs"));
        // SearchIndexJob runs only when a test asks what it would select: a run of its own would stamp the drafts under test.
        config.set("mail:jobs:search_index:schedule", "0 0 0 1 1 *");
        config.set("port", await freePort());
        config.set("listen_host", "127.0.0.1");
        registerCoreProviders(objectFactory, config, {
            searchProvider: PostgresFullTextSearchProvider,
            devDeliveryTransport: DevLocalDeliveryTransportSQL,
            environment: "test",
            blobStore: LocalFsBlobStore,
            dnsResolver: NodeDnsResolver,
            signingCertificateEnrollment: ManualSigningCertificateEnrollment,
        });
        server = new Server({ config, basePath: "./src/sql", logger, objectFactory });
        await server.start();
        await sleep(1000);
    }, 120_000);

    afterAll(async () => {
        await server?.stop();
        await fs.promises.rm(dir, { recursive: true, force: true });
    });

    defineComposeSendStampTests(() => ({
        objectFactory,
        routeClass: MailComposeRoute,
        messageClass: MessageSQL,
        mailboxClass: MailboxSQL,
        folderClass: FolderSQL,
    }));
});
