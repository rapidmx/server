///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
// MailComposeRoute against a real MongoDB (see helpers/composeSendStamp.ts for what is checked).
vi.mock("redis", async () => {
    const { createFakeRedisModule } = await import("../helpers/FakeRedis.js");
    return createFakeRedisModule();
});

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import config from "../../src/config.mongo.js";
import { MongoMemoryServer } from "mongodb-memory-server";
import { Logger, sleep } from "@rapidrest/core";
import { ObjectFactory, Server } from "@rapidrest/service-core";
import { LocalFsBlobStore, NodeDnsResolver, ManualSigningCertificateEnrollment } from "@rapidmx/restapi";
import { ConfigCipherMongo, FolderMongo, MailboxMongo, MessageMongo } from "@rapidmx/restapi/mongo";
import { MongoTextSearchProvider } from "@rapidmx/restapi/search";
import { DevLocalDeliveryTransportMongo } from "../../src/dev/DevLocalDeliveryTransportMongo.js";
import { registerCoreProviders } from "../../src/lib/registerCoreProviders.js";
import { MailComposeRoute } from "../../src/mongo/routes/MailComposeRoute.js";
import { defineComposeSendStampTests } from "../helpers/composeSendStamp.js";
import { freePort } from "../helpers/serverTestUtils.js";

describe("MailComposeRoute (MongoDB)", () => {
    const logger = new Logger("warn");
    const mongod: MongoMemoryServer = new MongoMemoryServer({ instance: { dbName: "mongomemory-compose-test" } });
    const blobRoot: string = fs.mkdtempSync(path.join(os.tmpdir(), "rmx-compose-blobs-"));
    const objectFactory = new ObjectFactory(config, logger);
    let server: Server;

    beforeAll(async () => {
        await mongod.start();
        for (const name of ["acl", "mongo"]) {
            config.set(`datastores:${name}:url`, mongod.getUri());
        }
        config.set("mail:blob:local:root", blobRoot);
        // SearchIndexJob runs only when a test asks what it would select: a run of its own would stamp the drafts under test.
        config.set("mail:jobs:search_index:schedule", "0 0 0 1 1 *");
        config.set("port", await freePort());
        config.set("listen_host", "127.0.0.1");
        registerCoreProviders(objectFactory, config, {
            searchProvider: MongoTextSearchProvider,
            configCipher: ConfigCipherMongo,
            devDeliveryTransport: DevLocalDeliveryTransportMongo,
            environment: "test",
            blobStore: LocalFsBlobStore,
            dnsResolver: NodeDnsResolver,
            signingCertificateEnrollment: ManualSigningCertificateEnrollment,
        });
        server = new Server({ config, basePath: "./src/mongo", logger, objectFactory });
        await server.start();
        await sleep(1000);
    }, 120_000);

    afterAll(async () => {
        await server?.stop();
        await mongod.stop();
        await fs.promises.rm(blobRoot, { recursive: true, force: true });
    });

    defineComposeSendStampTests(() => ({
        objectFactory,
        routeClass: MailComposeRoute,
        messageClass: MessageMongo,
        mailboxClass: MailboxMongo,
        folderClass: FolderMongo,
    }));
});
