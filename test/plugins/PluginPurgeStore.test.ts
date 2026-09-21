///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
// The purge ledger's compare-and-set transitions against a real MongoDB and a real (SQLite) SQL database: two server
// copies racing for the same purge must end with exactly one of them holding it.
import fs from "fs";
import os from "os";
import path from "path";
import nconf from "nconf";
import { MongoMemoryServer } from "mongodb-memory-server";
import { ConnectionManager, ObjectFactory } from "@rapidrest/service-core";
import { PluginPurgeMongo } from "../../src/mongo/PluginPurgeMongo.js";
import { PluginPurgeSQL } from "../../src/sql/PluginPurgeSQL.js";
import { PluginPurgeLedger, PurgeInProgressError } from "../../src/plugins/PluginPurgeLedger.js";
import { PluginPurgeStore } from "../../src/plugins/PluginPurgeStore.js";
import type { PluginOwnedModel } from "../../src/plugins/PluginPurgeTypes.js";

const logger: any = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => logger, log: vi.fn() };

function configWith(datastores: Record<string, any>) {
    const conf = new nconf.Provider();
    conf.use("memory");
    conf.defaults({ datastores });
    return conf;
}

interface Harness {
    store: PluginPurgeStore;
    /** A second ledger on the same database, as another server copy has. */
    other: PluginPurgeLedger;
    ledger: PluginPurgeLedger;
    close: () => Promise<void>;
}

const MODEL: PluginOwnedModel = { className: "BookingTypeX", datastore: "x", kind: "mongo", name: "booking_type_x" };
const DETAILS = { displayName: "Booking pages", packageVersion: "1.2.3", integrity: "sha512-abc", requestedBy: "admin-1", wasEnabled: true };

const mongod: MongoMemoryServer = new MongoMemoryServer({ instance: { dbName: "purge-store-test" } });
let sqlDir: string;

beforeAll(async () => {
    await mongod.start();
    sqlDir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-purge-store-"));
}, 120_000);

afterAll(async () => {
    await mongod.stop();
    fs.rmSync(sqlDir, { recursive: true, force: true });
});

async function open(kind: "mongo" | "sql", leaseMs: number = 60_000): Promise<Harness> {
    const isSql: boolean = kind === "sql";
    const datastores: Record<string, any> = isSql
        ? { sql: { type: "better-sqlite3", host: "localhost", database: path.join(sqlDir, `purge-${Math.random().toString(36).slice(2)}.db`), synchronize: true } }
        : { mongo: { type: "mongodb", url: mongod.getUri(`purge-${Math.random().toString(36).slice(2)}`), synchronize: true } };
    const modelClass: any = isSql ? PluginPurgeSQL : PluginPurgeMongo;
    const objectFactory = new ObjectFactory(configWith(datastores), logger);
    const manager: ConnectionManager = await objectFactory.newInstance(ConnectionManager, { name: `purge-${kind}` });
    await manager.connect(datastores, new Map<string, any>([[modelClass.name, modelClass]]));
    const connection: any = manager.connections.get(kind);
    const store = new PluginPurgeStore(connection, modelClass);
    return {
        store,
        ledger: new PluginPurgeLedger(store, leaseMs),
        other: new PluginPurgeLedger(new PluginPurgeStore(connection, modelClass), leaseMs),
        close: async () => {
            await manager.disconnect();
            await objectFactory.destroy();
        },
    };
}

describe.each(["mongo", "sql"] as const)("PluginPurgeLedger on %s", (kind) => {
    let h: Harness;
    beforeEach(async () => {
        h = await open(kind);
    }, 60_000);
    afterEach(async () => {
        await h.close();
    });

    const model = (): PluginOwnedModel => ({ ...MODEL, datastore: kind, kind });

    it("records what a plugin owns, growing it and writing nothing when it is already there", async () => {
        await h.ledger.recordInventory("@x/plugin", { version: "1.0.0", hook: false, models: [model()] });
        const first = (await h.ledger.get("@x/plugin"))!;
        expect(first.state).toBe("idle");
        expect(first.inventory).toEqual(expect.objectContaining({ version: "1.0.0", hook: false, models: [model()] }));

        // The same again: untouched (the timestamp is the proof).
        await h.other.recordInventory("@x/plugin", { version: "1.0.0", hook: false, models: [model()] });
        expect((await h.ledger.get("@x/plugin"))!.inventory!.updatedAt).toBe(first.inventory!.updatedAt);

        // A later version adds a collection and gains a hook; the older collection is still known.
        const added: PluginOwnedModel = { ...model(), className: "Other", name: "other_x" };
        await h.other.recordInventory("@x/plugin", { version: "1.1.0", hook: true, models: [added] });
        const grown = (await h.ledger.get("@x/plugin"))!.inventory!;
        expect(grown.version).toBe("1.1.0");
        expect(grown.hook).toBe(true);
        expect(grown.models.map((m) => m.name).sort()).toEqual(["booking_type_x", "other_x"]);
    });

    it("creates one record per plugin even when two copies create it at once", async () => {
        await Promise.all([h.ledger.recordInventory("@x/plugin", { version: "1", hook: false, models: [] }), h.other.recordInventory("@x/plugin", { version: "1", hook: false, models: [] })]);
        expect((await h.ledger.list()).filter((record) => record.name === "@x/plugin")).toHaveLength(1);
    });

    it("moves a request through pending, claimed, and done - keeping its steps and dropping the inventory", async () => {
        await h.ledger.recordInventory("@x/plugin", { version: "1.2.3", hook: false, models: [model()] });
        const requested = await h.ledger.request("@x/plugin", DETAILS, new Date("2026-09-21T10:00:00Z"));
        expect(requested).toEqual(expect.objectContaining({ state: "pending", requestedBy: "admin-1", wasEnabled: true, attempts: 0, steps: [] }));
        expect(requested.requestedAt).toEqual(new Date("2026-09-21T10:00:00Z"));
        expect((await h.ledger.unfinished()).map((record) => record.name)).toEqual(["@x/plugin"]);

        const claim = (await h.ledger.claim("@x/plugin", "pod-a", new Date("2026-09-21T10:05:00Z")))!;
        expect(claim.token.startsWith("pod-a#")).toBe(true);
        expect(claim.record).toEqual(expect.objectContaining({ state: "running", attempts: 1, leaseOwner: claim.token }));
        expect(claim.record.leaseExpiresAt).toEqual(new Date("2026-09-21T10:06:00Z"));

        const steps = [{ step: "data:x:booking_type_x", ok: true, count: 3 }];
        expect(await h.ledger.saveSteps("@x/plugin", claim.token, steps)).toBe(true);
        expect(await h.ledger.finish("@x/plugin", claim.token, "done", steps, undefined, new Date("2026-09-21T10:06:00Z"))).toBe(true);
        const done = (await h.ledger.get("@x/plugin"))!;
        expect(done).toEqual(expect.objectContaining({ state: "done", steps }));
        expect(done.completedAt).toEqual(new Date("2026-09-21T10:06:00Z"));
        expect(done.leaseOwner).toBeUndefined();
        expect(done.inventory).toBeUndefined();
        expect(await h.ledger.unfinished()).toEqual([]);
    });

    it("lets exactly one of two competing copies claim the purge", async () => {
        await h.ledger.request("@x/plugin", DETAILS);
        const results = await Promise.all([h.ledger.claim("@x/plugin", "pod-a"), h.other.claim("@x/plugin", "pod-b"), h.ledger.claim("@x/plugin", "pod-c")]);
        const winners = results.filter((result) => result !== null);
        expect(winners).toHaveLength(1);
        const record = (await h.ledger.get("@x/plugin"))!;
        expect(record.leaseOwner).toBe(winners[0].token);
        expect(record.attempts).toBe(1);

        // While the lease holds, nobody else gets it - and only the holder's token can write.
        expect(await h.other.claim("@x/plugin", "pod-b", new Date(Date.now() + 1000))).toBeNull();
        expect(await h.other.renew("@x/plugin", "pod-b#wrong")).toBe(false);
        expect(await h.other.saveSteps("@x/plugin", "pod-b#wrong", [])).toBe(false);
        expect(await h.other.finish("@x/plugin", "pod-b#wrong", "done", [])).toBe(false);
        expect(await h.other.release("@x/plugin", "pod-b#wrong", [])).toBe(false);
        expect(await h.ledger.renew("@x/plugin", winners[0].token)).toBe(true);
    });

    it("hands a lapsed lease to exactly one other copy, which resumes from the recorded steps", async () => {
        await h.ledger.request("@x/plugin", DETAILS);
        const dead = (await h.ledger.claim("@x/plugin", "pod-a", new Date("2026-09-21T10:00:00Z")))!;
        const steps = [{ step: "hook", ok: true }];
        await h.ledger.saveSteps("@x/plugin", dead.token, steps, new Date("2026-09-21T10:00:00Z"));
        // pod-a died; its lease ran out at 10:01. Two copies look at 10:02.
        const later = new Date("2026-09-21T10:02:00Z");
        const results = await Promise.all([h.ledger.claim("@x/plugin", "pod-b", later), h.other.claim("@x/plugin", "pod-c", later)]);
        expect(results.filter((result) => result !== null)).toHaveLength(1);
        const record = (await h.ledger.get("@x/plugin"))!;
        expect(record.attempts).toBe(2);
        expect(record.steps).toEqual(steps);
        expect(record.leaseOwner).not.toBe(dead.token);
        // The dead copy waking up finds it can't write any more.
        expect(await h.ledger.saveSteps("@x/plugin", dead.token, [], later)).toBe(false);
        expect(await h.ledger.finish("@x/plugin", dead.token, "done", [], undefined, later)).toBe(false);
    });

    it("has nothing to claim before a request, after it finished, or for an unknown plugin", async () => {
        expect(await h.ledger.claim("@x/none", "pod-a")).toBeNull();
        await h.ledger.recordInventory("@x/plugin", { version: "1", hook: false, models: [] });
        expect(await h.ledger.claim("@x/plugin", "pod-a")).toBeNull();
    });

    it("gives a lease back, returning the purge to pending with its steps", async () => {
        await h.ledger.request("@x/plugin", DETAILS);
        const claim = (await h.ledger.claim("@x/plugin", "pod-a"))!;
        const steps = [{ step: "hook", ok: true }];
        expect(await h.ledger.release("@x/plugin", claim.token, steps)).toBe(true);
        const record = (await h.ledger.get("@x/plugin"))!;
        expect(record).toEqual(expect.objectContaining({ state: "pending", steps }));
        expect(record.leaseOwner).toBeUndefined();
        expect(await h.other.claim("@x/plugin", "pod-b")).not.toBeNull();
    });

    it("cancels a pending purge when the plugin is added again, and can put it back", async () => {
        await h.ledger.request("@x/plugin", DETAILS);
        expect(await h.ledger.cancelPending("@x/plugin")).toBe("cancelled");
        expect((await h.ledger.get("@x/plugin"))!.state).toBe("cancelled");
        expect(await h.ledger.unfinished()).toEqual([]);
        expect(await h.ledger.claim("@x/plugin", "pod-a")).toBeNull();
        // Nothing to cancel any more, or for a plugin with no record.
        expect(await h.ledger.cancelPending("@x/plugin")).toBe("none");
        expect(await h.ledger.cancelPending("@x/unknown")).toBe("none");

        await h.ledger.uncancel("@x/plugin");
        expect((await h.ledger.get("@x/plugin"))!.state).toBe("pending");
        expect(await h.ledger.claim("@x/plugin", "pod-a")).not.toBeNull();
    });

    it("refuses to cancel - or start again - while a run is under way, even one whose lease lapsed", async () => {
        await h.ledger.request("@x/plugin", DETAILS);
        await h.ledger.claim("@x/plugin", "pod-a", new Date("2000-01-01T00:00:00Z"));
        await expect(h.other.cancelPending("@x/plugin")).rejects.toBeInstanceOf(PurgeInProgressError);
        await expect(h.other.request("@x/plugin", DETAILS)).rejects.toThrow(/being deleted right now/);
    });

    it("loses a cancel that races a claim, so the run wins and the cancel is refused", async () => {
        await h.ledger.request("@x/plugin", DETAILS);
        const outcomes = await Promise.allSettled([h.ledger.claim("@x/plugin", "pod-a"), h.other.cancelPending("@x/plugin")]);
        const claimed = (outcomes[0] as PromiseFulfilledResult<any>).value !== null;
        const cancelled = outcomes[1].status === "fulfilled";
        // Exactly one of the two happened.
        expect(claimed).not.toBe(cancelled);
        expect((await h.ledger.get("@x/plugin"))!.state).toBe(claimed ? "running" : "cancelled");
    });

    it("retries only a failed purge, keeping the steps that succeeded", async () => {
        await h.ledger.request("@x/plugin", DETAILS);
        const claim = (await h.ledger.claim("@x/plugin", "pod-a"))!;
        const steps = [
            { step: "hook", ok: true },
            { step: "data:x:booking_type_x", ok: false, error: "boom" },
        ];
        await h.ledger.finish("@x/plugin", claim.token, "failed", steps, "1 of 2 steps failed.");
        expect((await h.ledger.get("@x/plugin"))).toEqual(expect.objectContaining({ state: "failed", error: "1 of 2 steps failed." }));

        expect(await h.ledger.retry("@x/plugin")).toBe(true);
        const retried = (await h.ledger.get("@x/plugin"))!;
        expect(retried).toEqual(expect.objectContaining({ state: "pending", steps }));
        expect(retried.error).toBeUndefined();
        // Only a failed one can be retried.
        expect(await h.ledger.retry("@x/plugin")).toBe(false);
        expect(await h.ledger.retry("@x/unknown")).toBe(false);
    });

    it("starts a fresh purge over a finished, failed or cancelled one, and forgets an outcome when asked", async () => {
        await h.ledger.request("@x/plugin", DETAILS);
        const claim = (await h.ledger.claim("@x/plugin", "pod-a"))!;
        await h.ledger.finish("@x/plugin", claim.token, "done", [{ step: "hook", ok: true }]);

        const again = await h.ledger.request("@x/plugin", { ...DETAILS, requestedBy: "admin-2" });
        expect(again).toEqual(expect.objectContaining({ state: "pending", requestedBy: "admin-2", attempts: 0, steps: [] }));
        expect(again.completedAt).toBeUndefined();

        // Uninstalled again without deleting: the old outcome no longer describes the data. A pending one is left alone.
        await h.ledger.clearOutcome("@x/plugin");
        expect((await h.ledger.get("@x/plugin"))!.state).toBe("pending");
        expect(await h.ledger.abandon("@x/plugin")).toBe(true);
        await h.ledger.clearOutcome("@x/plugin");
        expect(await h.ledger.get("@x/plugin")).toEqual(expect.objectContaining({ state: "idle", steps: [], attempts: 0 }));
        expect((await h.ledger.get("@x/plugin"))!.requestedBy).toBeUndefined();
    });

    it("deletes a record", async () => {
        await h.ledger.recordInventory("@x/plugin", { version: "1", hook: false, models: [] });
        await h.store.remove("@x/plugin");
        expect(await h.ledger.get("@x/plugin")).toBeNull();
    });
});
