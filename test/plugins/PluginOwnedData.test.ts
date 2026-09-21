///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
// Which collections and tables a plugin's model classes use, on MongoDB and on SQL, and the guard that refuses to delete
// anything that isn't the plugin's own; then the deletion itself against a real MongoDB and a real SQLite database.
import fs from "fs";
import os from "os";
import path from "path";
import nconf from "nconf";
import { MongoMemoryServer } from "mongodb-memory-server";
import { AccessControlListMongo, BaseEntity, BaseMongoEntity, ConnectionManager, ModelDecorators, ObjectFactory, PersistenceDecorators } from "@rapidrest/service-core";
import { FolderMongo, MessageMongo } from "@rapidmx/restapi/mongo";
import { FolderSQL } from "@rapidmx/restapi/sql";
import {
    assertPurgeable,
    collectionNameOf,
    connectionKind,
    coreCollections,
    datastoreOf,
    describeModels,
    ownedKey,
    PurgeGuardError,
} from "../../src/plugins/PluginOwnedData.js";
import { deleteModelData } from "../../src/plugins/PluginPurgeData.js";
import type { PluginOwnedModel } from "../../src/plugins/PluginPurgeTypes.js";

const { DataStore } = ModelDecorators;
const { Column, Entity } = PersistenceDecorators;

// A plugin's models, as a plugin package declares them.
@DataStore("mongo")
@Entity()
class WidgetMongo extends BaseMongoEntity {
    @Column()
    public label: string = "";
}

@DataStore("mongo")
@Entity({ name: "custom_gadgets" })
class GadgetMongo extends BaseMongoEntity {
    @Column()
    public label: string = "";
}

@DataStore("sql")
@Entity()
class WidgetSQL extends BaseEntity {
    @Column()
    public label: string = "";
}

// A plugin that tries to claim a server collection: by naming it, or by extending a server model.
@DataStore("mongo")
@Entity({ name: "folder_mongo" })
class ClaimsFolderMongo extends BaseMongoEntity {}

class ExtendsFolderMongo extends FolderMongo {}

const logger: any = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => logger, log: vi.fn() };

function configWith(datastores: Record<string, any>) {
    const conf = new nconf.Provider();
    conf.use("memory");
    conf.defaults({ datastores });
    return conf;
}

const mongod: MongoMemoryServer = new MongoMemoryServer({ instance: { dbName: "owned-data-test" } });
let dir: string;
let mongoManager: ConnectionManager;
let sqlManager: ConnectionManager;
let objectFactory: ObjectFactory;
let mongo: any;
let sql: any;

beforeAll(async () => {
    await mongod.start();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-owned-data-"));
    const datastores = {
        mongo: { type: "mongodb", url: mongod.getUri("owned-data"), synchronize: true },
        sql: { type: "better-sqlite3", host: "localhost", database: path.join(dir, "owned.db"), synchronize: true },
    };
    objectFactory = new ObjectFactory(configWith(datastores), logger);
    mongoManager = await objectFactory.newInstance(ConnectionManager, { name: "owned-mongo" });
    await mongoManager.connect({ mongo: datastores.mongo }, new Map<string, any>([["WidgetMongo", WidgetMongo], ["GadgetMongo", GadgetMongo]]));
    sqlManager = await objectFactory.newInstance(ConnectionManager, { name: "owned-sql" });
    await sqlManager.connect({ sql: datastores.sql }, new Map<string, any>([["WidgetSQL", WidgetSQL], ["FolderSQL", FolderSQL]]));
    mongo = mongoManager.connections.get("mongo");
    sql = sqlManager.connections.get("sql");
}, 120_000);

afterAll(async () => {
    await mongoManager.disconnect();
    await sqlManager.disconnect();
    await objectFactory.destroy();
    await mongod.stop();
    fs.rmSync(dir, { recursive: true, force: true });
});

const connections = () => new Map<string, any>([["mongo", mongo], ["sql", sql], ["cache", { get: () => undefined }]]);

describe("deriving what a plugin's models are stored in", () => {
    it("names the Mongo collection from the connection, honouring an explicit entity name", () => {
        expect(connectionKind(mongo)).toBe("mongo");
        expect(collectionNameOf(mongo, WidgetMongo, "mongo")).toBe("widget_mongo");
        expect(collectionNameOf(mongo, GadgetMongo, "mongo")).toBe("custom_gadgets");
        expect(datastoreOf(WidgetMongo)).toBe("mongo");
    });

    it("names the SQL table from the connection's metadata, falling back to the naming rules before it exists", () => {
        expect(connectionKind(sql)).toBe("sql");
        expect(collectionNameOf(sql, WidgetSQL, "sql")).toBe("widget_sql");
        expect(collectionNameOf(undefined, WidgetSQL, "sql")).toBe("widget_sql");
        expect(collectionNameOf({}, GadgetMongo, "mongo")).toBe("custom_gadgets");
    });

    it("knows a Redis client, a missing connection and a non-model", () => {
        expect(connectionKind(undefined)).toBeUndefined();
        expect(connectionKind({ get: () => undefined })).toBeUndefined();
        expect(connectionKind({ options: { type: "mongodb" } })).toBe("mongo");
        expect(datastoreOf("not a class")).toBeUndefined();
        expect(datastoreOf(class Plain {})).toBeUndefined();
    });

    it("describes the models among a plugin's classes on both datastores, skipping what isn't one", () => {
        class NotAModel {}
        const { models, skipped } = describeModels(
            [
                ["WidgetMongo", WidgetMongo],
                ["GadgetMongo", GadgetMongo],
                ["WidgetSQL", WidgetSQL],
                ["NotAModel", NotAModel],
                ["SomeRoute", class SomeRoute {}],
            ],
            connections(),
        );
        expect(models).toEqual([
            { className: "WidgetMongo", datastore: "mongo", kind: "mongo", name: "widget_mongo" },
            { className: "GadgetMongo", datastore: "mongo", kind: "mongo", name: "custom_gadgets" },
            { className: "WidgetSQL", datastore: "sql", kind: "sql", name: "widget_sql" },
        ]);
        expect(skipped).toEqual([]);
    });

    it("reports a model whose datastore isn't a connected database", () => {
        const { models, skipped } = describeModels([["WidgetMongo", WidgetMongo]], new Map<string, any>([["cache", {}]]));
        expect(models).toEqual([]);
        expect(skipped).toEqual([{ className: "WidgetMongo", reason: "its datastore 'mongo' isn't a connected database" }]);
    });
});

describe("the guard that keeps a purge to the plugin's own data", () => {
    const own = (name: string, extra: Partial<PluginOwnedModel> = {}): PluginOwnedModel => ({ className: "Own", datastore: "mongo", kind: "mongo", name, ...extra });
    const empty = new Set<string>();

    it("derives the server's collections from its own classes and the framework's ACLs", () => {
        const core = coreCollections([["FolderMongo", FolderMongo], ["MessageMongo", MessageMongo], ["Other", class {}]], connections());
        expect(core.has(ownedKey("mongo", "folder_mongo"))).toBe(true);
        expect(core.has(ownedKey("mongo", "message_mongo"))).toBe(true);
        // service-core's own ACL model isn't scanned by the server's class loader, but is never a plugin's.
        expect(core.has(ownedKey("acl", "access_control_list_mongo"))).toBe(true);
        expect(AccessControlListMongo).toBeDefined();
    });

    it("refuses a plugin model that names a core collection, or extends a core model", () => {
        const core = coreCollections([["FolderMongo", FolderMongo]], connections());
        const claimed = describeModels([["ClaimsFolderMongo", ClaimsFolderMongo], ["ExtendsFolderMongo", ExtendsFolderMongo]], connections()).models;
        expect(claimed.map((model) => model.name)).toEqual(["folder_mongo", "folder_mongo"]);
        for (const model of claimed) {
            expect(() => assertPurgeable(model, { core, others: empty })).toThrow(PurgeGuardError);
            expect(() => assertPurgeable(model, { core, others: empty })).toThrow(/one of the server's own collections/);
        }
        // The same name on SQL, by a schema-qualified table.
        expect(() => assertPurgeable(own("public.folder_mongo"), { core, others: empty })).toThrow(/server's own/);
        // A different case is the same table on the databases that fold case.
        expect(() => assertPurgeable(own("FOLDER_MONGO"), { core, others: empty })).toThrow(/server's own/);
    });

    it("refuses a collection another plugin also uses", () => {
        expect(() => assertPurgeable(own("shared_things"), { core: empty, others: new Set([ownedKey("mongo", "shared_things")]) })).toThrow(/another plugin also uses it/);
    });

    it("refuses the protected datastore and names that aren't plain identifiers", () => {
        expect(() => assertPurgeable(own("anything", { datastore: "acl" }), { core: empty, others: empty })).toThrow(/never purged/);
        for (const name of ["", "system.users", "a b", "a;drop table x", "a/../b", "..", "a..b", "$cmd", "x".repeat(300)]) {
            expect(() => assertPurgeable(own(name), { core: empty, others: empty })).toThrow(PurgeGuardError);
        }
    });

    it("lets a plugin's own collections through", () => {
        const core = coreCollections([["FolderMongo", FolderMongo]], connections());
        for (const model of describeModels([["WidgetMongo", WidgetMongo], ["GadgetMongo", GadgetMongo], ["WidgetSQL", WidgetSQL]], connections()).models) {
            expect(() => assertPurgeable(model, { core, others: empty })).not.toThrow();
        }
    });
});

describe("deleting a model's data", () => {
    it("deletes every document of a Mongo collection, then drops it, and can be run again", async () => {
        const model = describeModels([["WidgetMongo", WidgetMongo]], connections()).models[0];
        const collection = mongo.db.collection("widget_mongo");
        await collection.insertMany([{ uid: "1", version: 1, label: "a" }, { uid: "2", version: 1, label: "b" }, { uid: "3", version: 1, label: "c" }]);
        // Another collection next to it stays.
        await mongo.db.collection("bystander").insertOne({ keep: true });

        expect(await deleteModelData(mongo, model)).toEqual({ count: 3 });
        expect((await mongo.db.listCollections({ name: "widget_mongo" }).toArray()).length).toBe(0);
        expect(await mongo.db.collection("bystander").countDocuments()).toBe(1);

        expect(await deleteModelData(mongo, model)).toEqual({ count: 0, note: "widget_mongo doesn't exist." });
    });

    it("deletes every row of a SQL table, then drops it, and can be run again", async () => {
        const model = describeModels([["WidgetSQL", WidgetSQL]], connections()).models[0];
        const repo = sql.getRepository(WidgetSQL);
        await repo.save([new WidgetSQL(), new WidgetSQL(), new WidgetSQL(), new WidgetSQL()]);
        await sql.getRepository(FolderSQL).save(new FolderSQL());

        expect(await deleteModelData(sql, model)).toEqual({ count: 4 });
        const tables = (await sql.query("select name from sqlite_master where type = 'table'")).map((t: any) => t.name);
        expect(tables).not.toContain("widget_sql");
        expect(tables).toContain("folder_sql");
        expect(await sql.getRepository(FolderSQL).count()).toBe(1);

        expect(await deleteModelData(sql, model)).toEqual({ count: 0, note: "widget_sql doesn't exist." });
    });

    it("refuses when the datastore isn't the kind the model was recorded on", async () => {
        const model: PluginOwnedModel = { className: "WidgetMongo", datastore: "sql", kind: "mongo", name: "widget_mongo" };
        await expect(deleteModelData(sql, model)).rejects.toThrow(/a sql connection, but WidgetMongo was recorded on a mongo one/);
        await expect(deleteModelData(undefined, model)).rejects.toThrow(/not a connected database/);
    });

    it("ignores a collection that disappeared between looking and dropping", async () => {
        const model: PluginOwnedModel = { className: "WidgetMongo", datastore: "mongo", kind: "mongo", name: "vanishing" };
        const drop = vi.fn().mockRejectedValue(Object.assign(new Error("ns not found"), { code: 26 }));
        const fake = { db: { listCollections: () => ({ toArray: async () => [{}] }), collection: () => ({ deleteMany: async () => ({ deletedCount: 2 }), drop }) }, collectionNameFor: () => "vanishing" };
        expect(await deleteModelData(fake, model)).toEqual({ count: 2 });
        drop.mockRejectedValue(Object.assign(new Error("not authorized"), { code: 13 }));
        await expect(deleteModelData(fake, model)).rejects.toThrow("not authorized");
    });
});
