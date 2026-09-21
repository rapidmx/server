///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
// The plugin route over HTTP, on a real server with a real MongoDB: uninstalling with and without the plugin's data, who
// may ask for it, what is audited, and the status and retry endpoints.
vi.mock("redis", async () => {
    const { createFakeRedisModule } = await import("../helpers/FakeRedis.js");
    return createFakeRedisModule();
});

import * as http from "http";
import { MongoMemoryServer } from "mongodb-memory-server";
import { JWTUtils, Logger, sleep } from "@rapidrest/core";
import { ConnectionManager, ObjectFactory, Server } from "@rapidrest/service-core";
import {
    FsDkimKeyProvider,
    LocalFsBlobStore,
    LocalX509CertificateAuthority,
    ManualSigningCertificateEnrollment,
    NodeDnsResolver,
    PostfixSendmailTransport,
} from "@rapidmx/restapi";
import { MongoTextSearchProvider } from "@rapidmx/restapi/search";
import { ClamAvScanProvider, RspamdSpamScanProvider } from "@rapidmx/restapi/scan";
import config from "../../src/config.mongo.js";
import { PluginPurgeMongo } from "../../src/mongo/PluginPurgeMongo.js";
import { PluginPurgeLedger } from "../../src/plugins/PluginPurgeLedger.js";
import { PluginPurgeStore } from "../../src/plugins/PluginPurgeStore.js";
import { PURGE_AUDIT } from "../../src/plugins/PluginPurger.js";
import { TieredRateLimiter } from "../../src/lib/TieredRateLimiter.js";
import { freePort } from "../helpers/serverTestUtils.js";

const mongod: MongoMemoryServer = new MongoMemoryServer({ instance: { dbName: "plugin-route-test" } });
const PLUGIN = "@rapidmx/notes-plugin";
const MANIFEST = { apiVersion: 1, displayName: "Notes", settings: [] };

interface Reply {
    status: number;
    body: any;
}

describe("PluginRoute over HTTP (MongoDB)", () => {
    const logger = new Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    objectFactory.register(LocalFsBlobStore, "BlobStore");
    objectFactory.register(MongoTextSearchProvider, "SearchProvider");
    objectFactory.register(RspamdSpamScanProvider, "SpamScanProvider");
    objectFactory.register(ClamAvScanProvider, "AvScanProvider");
    objectFactory.register(PostfixSendmailTransport, "MailTransport");
    objectFactory.register(NodeDnsResolver, "DnsResolver");
    objectFactory.register(FsDkimKeyProvider, "DkimKeyProvider");
    objectFactory.register(LocalX509CertificateAuthority, "EncryptionCertificateAuthority");
    objectFactory.register(ManualSigningCertificateEnrollment, "SigningCertificateEnrollment");
    objectFactory.register(TieredRateLimiter, "RateLimiter");
    let server: Server;
    let port: number;
    let db: any;
    let ledger: PluginPurgeLedger;
    let tokens: { admin: string; elevatedAdmin: string; user: string };

    const call = (method: string, path: string, token?: string, body?: unknown): Promise<Reply> =>
        new Promise((resolve, reject) => {
            const payload = body === undefined ? undefined : JSON.stringify(body);
            const headers: Record<string, string> = { ...(token ? { Authorization: `jwt ${token}` } : {}), ...(payload ? { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(payload)) } : {}) };
            const req = http.request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
                let text = "";
                res.setEncoding("utf-8");
                res.on("data", (chunk) => (text += chunk));
                res.on("end", () => {
                    let parsed: any = text;
                    try {
                        parsed = text ? JSON.parse(text) : undefined;
                    } catch {
                        // Not JSON.
                    }
                    resolve({ status: res.statusCode ?? 0, body: parsed });
                });
            });
            req.on("error", reject);
            req.end(payload);
        });

    const plugins = () => db.collection("plugin_mongo");

    async function installRow(uid: string, extra: Record<string, unknown> = {}): Promise<void> {
        await plugins().insertOne({ uid, version: 1, name: PLUGIN, packageVersion: "1.2.3", integrity: "sha512-x", enabled: true, removed: false, settings: {}, manifest: MANIFEST, dateCreated: new Date(), dateModified: new Date(), ...extra });
    }

    beforeAll(async () => {
        await mongod.start();
        for (const name of ["acl", "mongo"]) {
            config.set(`datastores:${name}:url`, mongod.getUri());
        }
        port = await freePort();
        config.set("port", port);
        config.set("listen_host", "127.0.0.1");
        server = new Server({ config, basePath: "./src/mongo", logger, objectFactory });
        await server.start();
        await sleep(1000);
        const connection: any = objectFactory.getInstance<ConnectionManager>(ConnectionManager)!.connections.get("mongo");
        db = connection.db;
        ledger = new PluginPurgeLedger(new PluginPurgeStore(connection, PluginPurgeMongo));
        const token = (roles: string[], elevated: number) => JWTUtils.createTokenSync(config.get("auth"), { uid: `user-${roles.join("")}-${elevated}`, roles, elevated } as any);
        tokens = { admin: token(["admin"], -1), elevatedAdmin: token(["admin"], Date.now()), user: token([], Date.now()) };
    }, 120_000);

    afterAll(async () => {
        await server.stop();
        await mongod.stop();
    });

    beforeEach(async () => {
        await plugins().deleteMany({});
        await db.collection("plugin_purge_mongo").deleteMany({});
        await db.collection("audit_log_entry_mongo").deleteMany({});
        await ledger.recordInventory(PLUGIN, { version: "1.2.3", hook: false, models: [{ className: "NoteMongo", datastore: "mongo", kind: "mongo", name: "note_mongo" }] });
    });

    const auditActions = async (): Promise<string[]> => (await db.collection("audit_log_entry_mongo").find({}).toArray()).map((entry: any) => entry.action);

    it("refuses every endpoint the plugin route has to a user who isn't a trusted role", async () => {
        await installRow("row-1");
        for (const [method, path, body] of [
            ["GET", "/api/system/plugins/status"],
            ["DELETE", "/api/system/plugins/row-1", { purgeData: true }],
            ["POST", "/api/system/plugins", { name: PLUGIN }],
            ["POST", "/api/system/plugins/purges/anything/retry"],
        ] as const) {
            expect((await call(method, path, tokens.user, body)).status, `${method} ${path}`).toBe(403);
        }
        expect(await plugins().countDocuments({ removed: false })).toBe(1);
    });

    it("keeps uninstalling as it was for a caller who sends no purgeData - trusted role alone is enough", async () => {
        await installRow("row-1");
        const reply = await call("DELETE", "/api/system/plugins/row-1", tokens.admin);
        expect(reply.status).toBe(200);
        expect(reply.body).toEqual({ purgeScheduled: false });
        expect(await plugins().findOne({ uid: "row-1" })).toEqual(expect.objectContaining({ removed: true, enabled: false }));
        expect((await ledger.get(PLUGIN))!.state).toBe("idle");
        expect(await auditActions()).toEqual(["plugin.remove"]);
    });

    it("refuses purgeData to a trusted caller who isn't elevated, changing nothing", async () => {
        await installRow("row-1");
        const reply = await call("DELETE", "/api/system/plugins/row-1", tokens.admin, { purgeData: true });
        expect(reply.status).toBe(403);
        expect(reply.body.code ?? reply.body.error).toEqual(expect.stringContaining("104"));
        expect(await plugins().findOne({ uid: "row-1" })).toEqual(expect.objectContaining({ removed: false, enabled: true }));
        expect((await ledger.get(PLUGIN))!.state).toBe("idle");
        expect(await auditActions()).toEqual([]);
    });

    it("refuses a purgeData that isn't a boolean, and an unknown plugin", async () => {
        await installRow("row-1");
        expect((await call("DELETE", "/api/system/plugins/row-1", tokens.elevatedAdmin, { purgeData: "yes" })).status).toBe(400);
        expect((await call("DELETE", "/api/system/plugins/no-such-row", tokens.elevatedAdmin, { purgeData: true })).status).toBe(404);
        expect(await plugins().countDocuments({ removed: false })).toBe(1);
    });

    it("uninstalls with the data of an elevated administrator's choosing: recorded as pending, audited with who asked", async () => {
        await installRow("row-1");
        const reply = await call("DELETE", "/api/system/plugins/row-1", tokens.elevatedAdmin, { purgeData: true });

        expect(reply.status).toBe(200);
        expect(reply.body).toEqual({ purgeScheduled: true, purge: expect.objectContaining({ name: PLUGIN, displayName: "Notes", state: "pending", requestedBy: expect.stringContaining("user-admin") }) });
        expect(await plugins().findOne({ uid: "row-1" })).toEqual(expect.objectContaining({ removed: true, enabled: false }));
        const record = (await ledger.get(PLUGIN))!;
        expect(record).toEqual(expect.objectContaining({ state: "pending", wasEnabled: true, packageVersion: "1.2.3", integrity: "sha512-x" }));

        const audits = await db.collection("audit_log_entry_mongo").find({}).toArray();
        expect(audits.map((entry: any) => entry.action).sort()).toEqual(["plugin.remove", PURGE_AUDIT.requested].sort());
        const requested = audits.find((entry: any) => entry.action === PURGE_AUDIT.requested);
        expect(requested).toEqual(expect.objectContaining({ targetType: "Plugin", targetUid: "row-1", actorUserUid: expect.stringContaining("user-admin") }));
        expect(requested.details).toEqual({ name: PLUGIN, purgeData: true, packageVersion: "1.2.3", wasEnabled: true });
    });

    it("also takes the flag on the query string", async () => {
        await installRow("row-1");
        const reply = await call("DELETE", "/api/system/plugins/row-1?purgeData=true", tokens.elevatedAdmin);
        expect(reply.body.purgeScheduled).toBe(true);
    });

    it("refuses to delete the data of a plugin no server ever recorded the data of, changing nothing", async () => {
        await installRow("row-1");
        await db.collection("plugin_purge_mongo").deleteMany({});
        const reply = await call("DELETE", "/api/system/plugins/row-1", tokens.elevatedAdmin, { purgeData: true });
        expect(reply.status).toBe(409);
        expect(await plugins().findOne({ uid: "row-1" })).toEqual(expect.objectContaining({ removed: false }));
    });

    it("lists the deletion in the status, and refuses to retry one that isn't failed", async () => {
        await installRow("row-1");
        await call("DELETE", "/api/system/plugins/row-1", tokens.elevatedAdmin, { purgeData: true });

        const status = await call("GET", "/api/system/plugins/status", tokens.admin);
        expect(status.status).toBe(200);
        expect(status.body.purges).toEqual([expect.objectContaining({ name: PLUGIN, state: "pending", serversTotal: 0 })]);
        expect(status.body.instances).toEqual([]);

        const uid = status.body.purges[0].uid;
        expect((await call("POST", `/api/system/plugins/purges/${uid}/retry`, tokens.admin)).status).toBe(403);
        const notFailed = await call("POST", `/api/system/plugins/purges/${uid}/retry`, tokens.elevatedAdmin);
        expect(notFailed.status).toBe(409);
        expect(notFailed.body.message ?? notFailed.body.error).toEqual(expect.stringContaining("Only a data deletion that failed can be retried"));

        // A failed one is retried.
        const claim = (await ledger.claim(PLUGIN, "pod-a"))!;
        await ledger.finish(PLUGIN, claim.token, "failed", [{ step: "hook", ok: false, error: "boom" }], "1 of 1 steps failed.");
        const retried = await call("POST", `/api/system/plugins/purges/${uid}/retry`, tokens.elevatedAdmin);
        expect(retried.status).toBe(200);
        expect(retried.body).toEqual(expect.objectContaining({ uid, state: "pending" }));
        expect(await auditActions()).toContain(PURGE_AUDIT.retried);
    });

    it("hides a deletion once its plugin is installed again, and still refuses an add with no name", async () => {
        await installRow("row-1");
        await call("DELETE", "/api/system/plugins/row-1", tokens.elevatedAdmin, { purgeData: true });
        await plugins().updateOne({ uid: "row-1" }, { $set: { removed: false, enabled: true } });
        const status = await call("GET", "/api/system/plugins/status", tokens.admin);
        expect(status.body.purges).toEqual([]);
        // The body reaches the add (the override keeps restapi's parameters): no name is restapi's own 400.
        const add = await call("POST", "/api/system/plugins", tokens.admin, {});
        expect(add.status).toBe(400);
    });
});
