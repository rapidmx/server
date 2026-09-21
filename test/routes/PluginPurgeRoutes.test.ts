///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
// What the server adds to restapi's plugin route: uninstalling with the plugin's data, cancelling it by adding the plugin
// again, its status, and retrying it - over restapi's route replaced by a fake, and a real (SQLite) ledger.
const recordAuditLog = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@rapidmx/restapi", async (importOriginal) => ({ ...(await importOriginal<any>()), recordAuditLog }));

import fs from "fs";
import os from "os";
import path from "path";
import nconf from "nconf";
import { ApiError } from "@rapidrest/core";
import { ConnectionManager, ObjectFactory } from "@rapidrest/service-core";
import { computePluginStateHash } from "@rapidmx/restapi";
import { PluginPurgeSQL } from "../../src/sql/PluginPurgeSQL.js";
import { PluginPurgeLedger } from "../../src/plugins/PluginPurgeLedger.js";
import { PluginPurgeStore } from "../../src/plugins/PluginPurgeStore.js";
import { PluginPurger, PURGE_AUDIT, setPluginPurger } from "../../src/plugins/PluginPurger.js";
import { parsePurgeData, requireElevation, toPurgeInfo, withPluginPurge } from "../../src/routes/PluginPurgeRoutes.js";

const PLUGIN = "@rapidmx/notes-plugin";
const DEP = "@rapidmx/dep-plugin";
const MANIFEST = { apiVersion: 1, displayName: "Notes" };
const logger: any = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => logger, log: vi.fn() };
const T0 = new Date("2026-09-21T12:00:00Z");

function configWith(datastores: Record<string, any>) {
    const conf = new nconf.Provider();
    conf.use("memory");
    conf.defaults({ datastores });
    return conf;
}

/** restapi's `BasePluginRoute`, as far as the mixin uses it. */
const base = {
    list: vi.fn(),
    status: vi.fn(),
    remove: vi.fn(),
    add: vi.fn(),
    plan: vi.fn(),
};
class FakeBase {
    public list(...args: any[]) {
        return (base.list as any)(...args);
    }
    public status(...args: any[]) {
        return (base.status as any)(...args);
    }
    public remove(...args: any[]) {
        return (base.remove as any)(...args);
    }
    public add(...args: any[]) {
        return (base.add as any)(...args);
    }
    public plan(...args: any[]) {
        return (base.plan as any)(...args);
    }
}

const Route: any = withPluginPurge(FakeBase, { datastore: "sql", purgeClass: PluginPurgeSQL });

let dir: string;
let objectFactory: ObjectFactory;
let manager: ConnectionManager;
let store: PluginPurgeStore;
let ledger: PluginPurgeLedger;
let route: any;
let installed: any[];

const row = (name: string, extra: Record<string, unknown> = {}) => ({ uid: `uid-${name}`, name, packageVersion: "1.2.3", integrity: "sha512-x", enabled: true, settings: {}, manifest: { ...MANIFEST, displayName: name === PLUGIN ? "Notes" : "Dep" }, ...extra });
const admin = { uid: "admin-1", roles: ["admin"], elevated: Date.now() };
const notElevated = { uid: "admin-2", roles: ["admin"], elevated: -1 };
const req = (body?: unknown, extra: Record<string, unknown> = {}) => ({ body, query: {}, ...extra }) as any;

beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-purge-routes-"));
    const datastores = { sql: { type: "better-sqlite3", host: "localhost", database: path.join(dir, "routes.db"), synchronize: true } };
    objectFactory = new ObjectFactory(configWith(datastores), logger);
    manager = await objectFactory.newInstance(ConnectionManager, { name: "routes" });
    await manager.connect(datastores, new Map<string, any>([["PluginPurgeSQL", PluginPurgeSQL]]));
    store = new PluginPurgeStore(manager.connections.get("sql"), PluginPurgeSQL);
});

afterAll(async () => {
    await manager.disconnect();
    await objectFactory.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
    vi.clearAllMocks();
    setPluginPurger(undefined);
    for (const record of await store.list()) {
        await store.remove(record.name);
    }
    ledger = new PluginPurgeLedger(store, 60_000);
    installed = [row(PLUGIN)];
    base.list.mockImplementation(async () => installed.filter((plugin) => !plugin.removed));
    base.status.mockImplementation(async () => ({ hash: computePluginStateHash(installed), instances: [] }));
    base.remove.mockImplementation(async (id: string) => {
        const found = installed.find((plugin) => plugin.uid === id && !plugin.removed);
        if (!found) {
            throw new ApiError("api-104", 404, "Not found");
        }
        found.removed = true;
        found.enabled = false;
    });
    base.add.mockImplementation(async (obj: any) => ({ plugin: row(obj.name), dependencies: [] }));
    base.plan.mockImplementation(async (name: string) => ({ plugin: { name }, install: [], enable: [], conflicts: [] }));
    route = new Route();
    route.purgeLedger = ledger;
    route.purgeLogger = logger;
    route.purgeConfig = { get: () => undefined };
    route._objectFactory = { name: "factory" };
    route.auditLogClass = class AuditLog {};
    // A purge that was recorded when the plugin loaded.
    await ledger.recordInventory(PLUGIN, { version: "1.2.3", hook: false, models: [{ className: "NoteSQL", datastore: "sql", kind: "sql", name: "note_sql" }] });
});

describe("the purgeData flag", () => {
    it("reads it from the JSON body, or the query string, and defaults to false", () => {
        expect(parsePurgeData({})).toBe(false);
        expect(parsePurgeData({ body: undefined, query: {} })).toBe(false);
        expect(parsePurgeData({ body: { purgeData: true } })).toBe(true);
        expect(parsePurgeData({ body: { purgeData: false } })).toBe(false);
        expect(parsePurgeData({ body: {} })).toBe(false);
        expect(parsePurgeData({ query: { purgeData: "true" } })).toBe(true);
        expect(parsePurgeData({ query: { purgeData: "false" } })).toBe(false);
        // A body that isn't an object (an older client's empty one, raw bytes, a string) says nothing.
        expect(parsePurgeData({ body: Buffer.from("x") })).toBe(false);
        expect(parsePurgeData({ body: "purgeData=true" })).toBe(false);
        expect(parsePurgeData({ body: null })).toBe(false);
    });

    it("refuses a value that isn't true or false", () => {
        for (const bad of [{ body: { purgeData: "yes" } }, { body: { purgeData: 1 } }, { body: { purgeData: null } }, { query: { purgeData: "1" } }, { query: { purgeData: ["true"] } }]) {
            expect(() => parsePurgeData(bad)).toThrow(expect.objectContaining({ status: 400, message: "'purgeData' must be true or false." }));
        }
    });

    it("takes an elevated caller, on the token or the request, and refuses everyone else", () => {
        expect(() => requireElevation({}, admin as any)).not.toThrow();
        expect(() => requireElevation({ user: admin as any }, undefined)).not.toThrow();
        for (const caller of [notElevated, { uid: "x", roles: ["admin"] }, { uid: "x", roles: ["admin"], elevated: 0 }, undefined]) {
            expect(() => requireElevation({}, caller as any)).toThrow(expect.objectContaining({ status: 403 }));
        }
    });
});

describe("DELETE /:id", () => {
    it("uninstalls exactly as before when purgeData is absent, needing no elevation and touching no ledger record", async () => {
        const result = await route.remove("uid-" + PLUGIN, req(undefined), notElevated);
        expect(result).toEqual({ purgeScheduled: false });
        expect(base.remove).toHaveBeenCalledTimes(1);
        expect((await ledger.get(PLUGIN))!.state).toBe("idle");
        expect(recordAuditLog).not.toHaveBeenCalled();

        // An older client's `purgeData: false` is the same.
        installed = [row(PLUGIN)];
        expect(await route.remove("uid-" + PLUGIN, req({ purgeData: false }), notElevated)).toEqual({ purgeScheduled: false });
    });

    it("forgets an earlier deletion's outcome when the plugin is uninstalled again without deleting", async () => {
        await ledger.request(PLUGIN, { wasEnabled: true }, T0);
        const claim = (await ledger.claim(PLUGIN, "pod-a"))!;
        await ledger.finish(PLUGIN, claim.token, "done", [{ step: "hook", ok: true }]);
        await route.remove("uid-" + PLUGIN, req(undefined), admin);
        expect((await ledger.get(PLUGIN))!.state).toBe("idle");
    });

    it("refuses purgeData to a caller who isn't elevated, before changing anything", async () => {
        await expect(route.remove("uid-" + PLUGIN, req({ purgeData: true }), notElevated)).rejects.toMatchObject({ status: 403 });
        expect(base.remove).not.toHaveBeenCalled();
        expect(installed[0].removed).toBeUndefined();
        expect((await ledger.get(PLUGIN))!.state).toBe("idle");
        expect(recordAuditLog).not.toHaveBeenCalled();
    });

    it("refuses purgeData for a plugin whose data was never recorded, before changing anything", async () => {
        await store.remove(PLUGIN);
        await expect(route.remove("uid-" + PLUGIN, req({ purgeData: true }), admin)).rejects.toMatchObject({
            status: 409,
            message: expect.stringContaining("No server has recorded which data Notes stores"),
        });
        expect(base.remove).not.toHaveBeenCalled();
    });

    it("uninstalls, records the deletion as pending, audits the request and its actor, and reports how many servers still run it", async () => {
        const kicked = vi.spyOn(PluginPurger.prototype, "kick").mockImplementation(() => undefined);
        setPluginPurger(new PluginPurger({} as any));
        base.status.mockResolvedValue({
            hash: "desired",
            instances: [
                { instance: "pod-a", hash: "desired", loaded: [], errors: [], safeMode: false, updatedAt: new Date().toISOString() },
                { instance: "pod-b", hash: "old", loaded: [{ name: PLUGIN, version: "1.2.3" }], errors: [], safeMode: false, updatedAt: new Date().toISOString() },
            ],
        });
        const request = req({ purgeData: true });

        const result = await route.remove("uid-" + PLUGIN, request, admin);

        expect(base.remove).toHaveBeenCalledWith("uid-" + PLUGIN, request, admin);
        expect(result.purgeScheduled).toBe(true);
        expect(result.purge).toEqual(expect.objectContaining({ name: PLUGIN, displayName: "Notes", state: "pending", requestedBy: "admin-1", serversRunning: 1, serversTotal: 2 }));
        const record = (await ledger.get(PLUGIN))!;
        expect(record).toEqual(expect.objectContaining({ state: "pending", requestedBy: "admin-1", wasEnabled: true, packageVersion: "1.2.3", integrity: "sha512-x", displayName: "Notes" }));
        expect(recordAuditLog).toHaveBeenCalledTimes(1);
        const [factory, auditClass, caller, entry] = recordAuditLog.mock.calls[0] as any[];
        expect(factory).toBe(route._objectFactory);
        expect(auditClass).toBe(route.auditLogClass);
        expect(caller).toEqual(expect.objectContaining({ req: request, user: admin }));
        expect(entry).toEqual({
            action: PURGE_AUDIT.requested,
            targetType: "Plugin",
            targetUid: "uid-" + PLUGIN,
            details: { name: PLUGIN, purgeData: true, packageVersion: "1.2.3", wasEnabled: true },
        });
        expect(kicked).toHaveBeenCalledTimes(1);
        kicked.mockRestore();
    });

    it("accepts the flag on the query string, and reports without status counts when status can't be read", async () => {
        base.status.mockRejectedValue(new Error("redis down"));
        const result = await route.remove("uid-" + PLUGIN, req(undefined, { query: { purgeData: "true" } }), admin);
        expect(result.purgeScheduled).toBe(true);
        expect(result.purge.serversTotal).toBe(0);
    });

    it("changes nothing when the uninstall itself is refused", async () => {
        base.remove.mockRejectedValueOnce(new ApiError("api-105", 409, "Other requires Notes"));
        await expect(route.remove("uid-" + PLUGIN, req({ purgeData: true }), admin)).rejects.toMatchObject({ status: 409 });
        expect((await ledger.get(PLUGIN))!.state).toBe("idle");
        expect(recordAuditLog).not.toHaveBeenCalled();
    });

    it("leaves a missing plugin to the base route's 404", async () => {
        await expect(route.remove("no-such-uid", req({ purgeData: true }), admin)).rejects.toMatchObject({ status: 404 });
        expect(await route.remove("no-such-uid", req(undefined), admin).catch((err: any) => err.status)).toBe(404);
    });

    it("answers with no deletion when the plugin vanished between the read and the uninstall", async () => {
        base.list.mockResolvedValueOnce([]);
        expect(await route.remove("uid-" + PLUGIN, req(undefined), admin)).toEqual({ purgeScheduled: false });
    });
});

describe("POST / (adding a plugin)", () => {
    const add = (name: string = PLUGIN) => route.add({ name }, req(), admin);

    it("adds as before when no deletion is waiting", async () => {
        const result = await add();
        expect(result.plugin.name).toBe(PLUGIN);
        expect(result.purgeCancelled).toBeUndefined();
        expect(result.warnings).toBeUndefined();
        expect(base.plan).not.toHaveBeenCalled();
    });

    it("cancels the plugin's pending deletion, says so, and audits it", async () => {
        await ledger.request(PLUGIN, { displayName: "Notes", wasEnabled: true }, T0);
        const result = await add();
        expect((await ledger.get(PLUGIN))!.state).toBe("cancelled");
        expect(result.purgeCancelled).toEqual([PLUGIN]);
        expect(result.warnings).toEqual(["The pending deletion of Notes's data was cancelled because the plugin was added again. Its data is kept."]);
        expect(recordAuditLog.mock.calls[0][3]).toEqual(expect.objectContaining({ action: PURGE_AUDIT.cancelled, targetUid: `uid-${PLUGIN}`, details: { name: PLUGIN, reason: "The plugin was added again." } }));
    });

    it("also cancels the deletion of a plugin it requires, which adding it brings back", async () => {
        await ledger.recordInventory(DEP, { version: "1", hook: false, models: [] });
        await ledger.request(DEP, { displayName: "Dep", wasEnabled: false }, T0);
        base.plan.mockResolvedValue({ plugin: { name: PLUGIN }, install: [{ name: DEP, version: "1.0.0" }], enable: [], conflicts: [] });
        const result = await add();
        expect(base.plan).toHaveBeenCalledWith(PLUGIN, undefined);
        expect(result.purgeCancelled).toEqual([DEP]);
        expect((await ledger.get(DEP))!.state).toBe("cancelled");
    });

    it("still adds when the dependency preview fails - the add reports what is wrong with it", async () => {
        await ledger.request(DEP, { wasEnabled: false }, T0);
        base.plan.mockRejectedValue(new Error("registry down"));
        const result = await add();
        expect(result.purgeCancelled).toBeUndefined();
        expect((await ledger.get(DEP))!.state).toBe("pending");
    });

    it("refuses while the plugin's data is being deleted, changing nothing", async () => {
        await ledger.request(PLUGIN, { wasEnabled: true }, T0);
        await ledger.claim(PLUGIN, "pod-a");
        await expect(add()).rejects.toMatchObject({ status: 409, message: expect.stringContaining("is being deleted right now") });
        expect(base.add).not.toHaveBeenCalled();
        expect((await ledger.get(PLUGIN))!.state).toBe("running");
    });

    it("refuses while a plugin it requires is being deleted, putting back the deletions it had cancelled", async () => {
        await ledger.request(PLUGIN, { wasEnabled: true }, T0);
        await ledger.recordInventory(DEP, { version: "1", hook: false, models: [] });
        await ledger.request(DEP, { wasEnabled: true }, T0);
        await ledger.claim(DEP, "pod-a");
        base.plan.mockResolvedValue({ plugin: { name: PLUGIN }, install: [{ name: DEP, version: "1.0.0" }], enable: [], conflicts: [] });
        await expect(add()).rejects.toMatchObject({ status: 409 });
        expect((await ledger.get(PLUGIN))!.state).toBe("pending");
        expect((await ledger.get(DEP))!.state).toBe("running");
    });

    it("puts the deletion back when the add fails", async () => {
        await ledger.request(PLUGIN, { wasEnabled: true }, T0);
        base.add.mockRejectedValueOnce(new ApiError("api-105", 409, "The plugins this change needs have changed"));
        await expect(add()).rejects.toMatchObject({ status: 409 });
        expect((await ledger.get(PLUGIN))!.state).toBe("pending");
        expect(recordAuditLog).not.toHaveBeenCalled();
    });

    it("leaves a request without a usable name to the base route", async () => {
        await ledger.request(PLUGIN, { wasEnabled: true }, T0);
        base.add.mockRejectedValueOnce(new ApiError("api-101", 400, "'name' is required."));
        await expect(route.add(undefined, req(), admin)).rejects.toMatchObject({ status: 400 });
        await expect(route.add({ name: 5 }, req(), admin)).resolves.toBeDefined();
        expect((await ledger.get(PLUGIN))!.state).toBe("pending");
    });
});

describe("GET /status", () => {
    it("adds the uninstalled plugins' data deletions to restapi's status", async () => {
        await ledger.request(PLUGIN, { displayName: "Notes", requestedBy: "admin-1", wasEnabled: true }, T0);
        installed = [row(PLUGIN, { removed: true, enabled: false })];
        const status = await route.status();
        expect(status.hash).toBe(computePluginStateHash(installed));
        expect(status.purges).toEqual([expect.objectContaining({ name: PLUGIN, state: "pending", displayName: "Notes", requestedAt: T0.toISOString(), serversRunning: 0, serversTotal: 0 })]);
    });

    it("leaves out plugins that are installed, never asked for, or cancelled - and lists the rest by name", async () => {
        await ledger.request(PLUGIN, { wasEnabled: true }, T0);
        await ledger.recordInventory(DEP, { version: "1", hook: false, models: [] });
        await ledger.recordInventory("@rapidmx/a-plugin", { version: "1", hook: false, models: [] });
        await ledger.request("@rapidmx/a-plugin", { wasEnabled: false }, T0);
        await ledger.request("@rapidmx/b-plugin", { wasEnabled: false }, T0);
        await ledger.cancelPending("@rapidmx/b-plugin");
        installed = [row(PLUGIN), row("@rapidmx/a-plugin", { removed: true }), row(DEP, { removed: true })];
        // Installed: hidden. Idle (DEP): hidden. Cancelled (b): hidden.
        const status = await route.status();
        expect(status.purges.map((purge: any) => purge.name)).toEqual(["@rapidmx/a-plugin"]);
    });

    it("still answers when the deletions can't be read", async () => {
        route.purgeLedger = { list: async () => { throw new Error("table missing"); } };
        const status = await route.status();
        expect(status.purges).toEqual([]);
        expect(logger.warn).toHaveBeenCalledWith("Could not read the plugin data deletions: table missing");
    });
});

describe("POST /purges/:uid/retry", () => {
    async function failed(): Promise<string> {
        await ledger.request(PLUGIN, { wasEnabled: true }, T0);
        const claim = (await ledger.claim(PLUGIN, "pod-a"))!;
        await ledger.finish(PLUGIN, claim.token, "failed", [{ step: "hook", ok: false, error: "boom" }, { step: "settings", ok: true }], "1 of 2 steps failed.");
        return (await ledger.get(PLUGIN))!.uid;
    }

    it("takes a failed deletion back to pending, audits it, and nudges the purger", async () => {
        const kicked = vi.spyOn(PluginPurger.prototype, "kick").mockImplementation(() => undefined);
        setPluginPurger(new PluginPurger({} as any));
        const uid = await failed();

        const info = await route.retryPurge(uid, req(), admin);

        expect(info).toEqual(expect.objectContaining({ uid, name: PLUGIN, state: "pending" }));
        expect((await ledger.get(PLUGIN))!.steps).toEqual([{ step: "hook", ok: false, error: "boom" }, { step: "settings", ok: true }]);
        expect(recordAuditLog.mock.calls[0][3]).toEqual(expect.objectContaining({ action: PURGE_AUDIT.retried, details: { name: PLUGIN, failedSteps: ["hook"] } }));
        expect(kicked).toHaveBeenCalledTimes(1);
        kicked.mockRestore();
    });

    it("needs an elevated caller, an existing deletion, and a failed one", async () => {
        const uid = await failed();
        await expect(route.retryPurge(uid, req(), notElevated)).rejects.toMatchObject({ status: 403 });
        await expect(route.retryPurge("no-such-uid", req(), admin)).rejects.toMatchObject({ status: 404 });
        await route.retryPurge(uid, req(), admin);
        await expect(route.retryPurge(uid, req(), admin)).rejects.toMatchObject({ status: 409, message: "Only a data deletion that failed can be retried." });
    });

    it("reports a retry that another administrator won", async () => {
        const uid = await failed();
        const raced: any = Object.create(ledger);
        raced.retry = async () => false;
        route.purgeLedger = raced;
        await expect(route.retryPurge(uid, req(), admin)).rejects.toMatchObject({ status: 409, message: expect.stringContaining("changed while it was being retried") });
    });
});

describe("the ledger of a route", () => {
    it("builds its own from the server's datastore connection", async () => {
        const fresh: any = new Route();
        fresh._objectFactory = { getInstance: () => ({ connections: new Map([["sql", manager.connections.get("sql")]]) }) };
        expect(fresh.getPurgeLedger()).toBeInstanceOf(PluginPurgeLedger);
        expect(fresh.getPurgeLedger()).toBe(fresh.getPurgeLedger());
        await ledger.request(PLUGIN, { wasEnabled: true }, T0);
        expect((await fresh.getPurgeLedger().get(PLUGIN)).state).toBe("pending");
    });

    it("describes a record without status counts when there is no status", () => {
        const info = toPurgeInfo({ uid: "u", name: PLUGIN, state: "pending", steps: [], attempts: 0 });
        expect(info.state).toBe("pending");
        expect(info.serversRunning).toBeUndefined();
        expect(info.serversTotal).toBeUndefined();
    });
});
