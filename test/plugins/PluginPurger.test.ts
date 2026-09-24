///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
// When an uninstalled plugin's data is deleted, and when it is not: against a real SQLite database (the plugin's table,
// the ledger), with the other server copies' status, the hook and the audit log replaced by test doubles.
import fs from "fs";
import os from "os";
import path from "path";
import nconf from "nconf";
import { computePluginStateHash } from "@rapidmx/restapi";
import { FolderSQL } from "@rapidmx/restapi/sql";
import { BaseEntity, ConnectionManager, ModelDecorators, ObjectFactory, PersistenceDecorators } from "@rapidrest/service-core";
import { PluginPurgeSQL } from "../../src/sql/PluginPurgeSQL.js";
import { DEFAULT_STARTING_MAX_AGE_MS } from "../../src/plugins/PluginPurgeCoordination.js";
import { PluginPurgeLedger } from "../../src/plugins/PluginPurgeLedger.js";
import { PluginPurgeStore } from "../../src/plugins/PluginPurgeStore.js";
import { getPluginPurger, PluginPurger, PURGE_AUDIT, setPluginPurger, type PluginPurgerOptions } from "../../src/plugins/PluginPurger.js";
import { AbortPurgeError, type PluginOwnedModel, type PluginPurgeRecord } from "../../src/plugins/PluginPurgeTypes.js";

const { DataStore } = ModelDecorators;
const { Column, Entity } = PersistenceDecorators;

@DataStore("sql")
@Entity({ name: "note_x_sql" })
class NoteXSQL extends BaseEntity {
    @Column()
    public label: string = "";
}

@DataStore("sql")
@Entity({ name: "note_y_sql" })
class NoteYSQL extends BaseEntity {
    @Column()
    public label: string = "";
}

const PLUGIN = "@rapidmx/notes-plugin";
const logger: any = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => logger, log: vi.fn() };
const MANIFEST = { apiVersion: 1, displayName: "Notes" };
const T0 = new Date("2026-09-21T12:00:00Z");

function configWith(datastores: Record<string, any>) {
    const conf = new nconf.Provider();
    conf.use("memory");
    conf.defaults({ datastores });
    return conf;
}

const model = (className: string, name: string): PluginOwnedModel => ({ className, datastore: "sql", kind: "sql", name });
const NOTE_X = model("NoteXSQL", "note_x_sql");
const NOTE_Y = model("NoteYSQL", "note_y_sql");

let dir: string;
let objectFactory: ObjectFactory;
let manager: ConnectionManager;
let sql: any;
let store: PluginPurgeStore;
let ledger: PluginPurgeLedger;
let pluginsDir: string;
let clock: Date;
let rows: any[];
let snapshot: any;
let coordination: { configured: boolean; snapshot: ReturnType<typeof vi.fn> };
let hooks: { run: ReturnType<typeof vi.fn> };
let audit: ReturnType<typeof vi.fn>;
let clearSettings: ReturnType<typeof vi.fn>;
let loaded: Map<string, PluginOwnedModel[]>;

/** What another server copy reports. */
const report = (instance: string, extra: Record<string, unknown> = {}) => ({
    instance,
    hash: computePluginStateHash(rows),
    loaded: [],
    errors: [],
    safeMode: false,
    updatedAt: clock.toISOString(),
    ...extra,
});

const removedRow = (extra: Record<string, unknown> = {}) => ({ uid: "row-1", name: PLUGIN, packageVersion: "1.2.3", enabled: false, removed: true, settings: { "notes:key": "v" }, manifest: MANIFEST, ...extra });

function purger(overrides: Partial<PluginPurgerOptions> = {}, instance: string = "pod-a"): PluginPurger {
    return new PluginPurger({
        instance,
        config: { get: () => undefined },
        logger,
        ledger,
        leaseMs: 60_000,
        coordination,
        connections: new Map<string, any>([["sql", sql]]),
        coreClasses: () => [["FolderSQL", FolderSQL]],
        loadedPlugins: () => loaded,
        readRows: async () => rows,
        clearSettings,
        hooks,
        hookContext: () => ({ connection: () => undefined, config: { get: () => undefined }, logger }),
        pluginsDir,
        audit,
        now: () => clock,
        graceMs: 180_000,
        ...overrides,
    });
}

async function tables(): Promise<string[]> {
    return (await sql.query("select name from sqlite_master where type = 'table'")).map((t: any) => t.name);
}

/** Records what the plugin owns, has an administrator uninstall it with its data at `requested`, and fills its tables. */
async function uninstalled(options: { hook?: boolean; enabled?: boolean; requested?: Date; models?: PluginOwnedModel[] } = {}): Promise<void> {
    await ledger.recordInventory(PLUGIN, { version: "1.2.3", hook: !!options.hook, models: options.models ?? [NOTE_X, NOTE_Y] });
    await ledger.request(PLUGIN, { displayName: "Notes", packageVersion: "1.2.3", integrity: "sha512-x", requestedBy: "admin-1", wasEnabled: options.enabled ?? false }, options.requested ?? T0);
    await sql.getRepository(NoteXSQL).save([new NoteXSQL(), new NoteXSQL()]);
    await sql.getRepository(NoteYSQL).save([new NoteYSQL()]);
}

beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-purger-"));
    const datastores = { sql: { type: "better-sqlite3", host: "localhost", database: path.join(dir, "purger.db"), synchronize: true } };
    objectFactory = new ObjectFactory(configWith(datastores), logger);
    manager = await objectFactory.newInstance(ConnectionManager, { name: "purger" });
    await manager.connect(datastores, new Map<string, any>([["PluginPurgeSQL", PluginPurgeSQL], ["NoteXSQL", NoteXSQL], ["NoteYSQL", NoteYSQL], ["FolderSQL", FolderSQL]]));
    sql = manager.connections.get("sql");
    store = new PluginPurgeStore(sql, PluginPurgeSQL);
});

afterAll(async () => {
    await manager.disconnect();
    await objectFactory.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
    vi.clearAllMocks();
    setPluginPurger(undefined);
    ledger = new PluginPurgeLedger(store, 60_000);
    clock = new Date(T0.getTime() + 10 * 60_000);
    rows = [removedRow()];
    loaded = new Map();
    snapshot = { instances: [], restartLockHeld: false, starting: [] };
    coordination = { configured: true, snapshot: vi.fn(async () => snapshot) };
    hooks = { run: vi.fn(async () => ({ ran: true })) };
    audit = vi.fn(async () => undefined);
    clearSettings = vi.fn(async () => undefined);
    pluginsDir = path.join(dir, `plugins-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(pluginsDir, { recursive: true });
    for (const record of await store.list()) {
        await store.remove(record.name);
    }
    // The tables a previous test may have dropped.
    await sql.synchronize();
    await sql.query("delete from note_x_sql");
    await sql.query("delete from note_y_sql");
});

describe("PluginPurger: when the data is deleted", () => {
    it("deletes the data of a plugin nothing runs: its tables, its saved settings, its files - each step recorded", async () => {
        await uninstalled();
        const build = path.join(pluginsDir, ".ui-build", "a".repeat(64));
        fs.mkdirSync(path.join(build, ".vite"), { recursive: true });
        fs.writeFileSync(path.join(build, ".vite", "manifest.json"), JSON.stringify({ "plugins/node_modules/@rapidmx/notes-plugin/apps/n/index.tsx": {} }));
        const pkg = path.join(pluginsDir, "node_modules", "@rapidmx", "notes-plugin");
        fs.mkdirSync(pkg, { recursive: true });
        fs.writeFileSync(path.join(pkg, "package.json"), "{}");
        snapshot.instances = [report("pod-a"), report("pod-b")];

        await purger().check();

        const record = (await ledger.get(PLUGIN))!;
        expect(record.state).toBe("done");
        expect(record.error).toBeUndefined();
        expect(record.inventory).toBeUndefined();
        expect(record.steps).toEqual([
            { step: "data:sql:note_x_sql", ok: true, count: 2 },
            { step: "data:sql:note_y_sql", ok: true, count: 1 },
            expect.objectContaining({ step: "blobs", ok: true }),
            { step: "settings", ok: true },
            { step: "files", ok: true, count: 2 },
        ]);
        expect(await tables()).not.toContain("note_x_sql");
        expect(await tables()).not.toContain("note_y_sql");
        expect(await tables()).toContain("folder_sql");
        expect(clearSettings).toHaveBeenCalledTimes(1);
        expect(fs.existsSync(pkg)).toBe(false);
        expect(fs.existsSync(build)).toBe(false);
        expect(hooks.run).not.toHaveBeenCalled();
        expect(audit).toHaveBeenCalledWith(PURGE_AUDIT.completed, { uid: "row-1", name: PLUGIN }, expect.objectContaining({ requestedBy: "admin-1" }));
    });

    it("waits while any server copy still runs the plugin, and shows how many do", async () => {
        await uninstalled();
        snapshot.instances = [report("pod-a"), report("pod-b", { loaded: [{ name: PLUGIN, version: "1.2.3" }], hash: "old" }), report("pod-c", { hash: "old" })];
        await purger().check();
        expect((await ledger.get(PLUGIN))!.state).toBe("pending");
        expect(await tables()).toContain("note_x_sql");
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("2 of 3 servers still run the plugin or haven't applied its removal (pod-b, pod-c)"));

        // Each server acknowledges by restarting into the plugin set without it; the last one to do so lets the purge go.
        snapshot.instances = [report("pod-a"), report("pod-b"), report("pod-c", { hash: "old" })];
        await purger().check();
        expect((await ledger.get(PLUGIN))!.state).toBe("pending");
        snapshot.instances = [report("pod-a"), report("pod-b"), report("pod-c")];
        await purger().check();
        expect((await ledger.get(PLUGIN))!.state).toBe("done");
        expect(await tables()).not.toContain("note_x_sql");
    });

    it("treats a copy that fails to load the plugin as still running it, but not one in safe mode or one that went away", async () => {
        await uninstalled();
        snapshot.instances = [report("pod-a", { errors: [{ name: PLUGIN, message: "boom" }], hash: "old" })];
        await purger().check();
        expect((await ledger.get(PLUGIN))!.state).toBe("pending");
        snapshot.instances = [
            report("pod-a", { safeMode: true, hash: computePluginStateHash([]) + "x" }),
            report("gone", { loaded: [{ name: PLUGIN, version: "1.2.3" }], updatedAt: new Date(clock.getTime() - 10 * 60_000).toISOString() }),
            report("pod-b"),
        ];
        await purger().check();
        expect((await ledger.get(PLUGIN))!.state).toBe("done");
    });

    it("never deletes while this copy itself runs the plugin", async () => {
        await uninstalled();
        loaded = new Map([[PLUGIN, [NOTE_X]]]);
        snapshot.instances = [report("pod-a")];
        await purger().check();
        expect((await ledger.get(PLUGIN))!.state).toBe("pending");
        expect(coordination.snapshot).not.toHaveBeenCalled();
        expect(await tables()).toContain("note_x_sql");
    });

    it("waits when the other copies' status can't be read, while a rollout holds the restart lock, and while a copy is starting", async () => {
        await uninstalled();
        coordination.snapshot.mockRejectedValueOnce(new Error("redis down"));
        await purger().check();
        expect((await ledger.get(PLUGIN))!.state).toBe("pending");
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("status can't be read (redis down)"));

        snapshot = { instances: [report("pod-a")], restartLockHeld: true, starting: [] };
        await purger().check();
        expect((await ledger.get(PLUGIN))!.state).toBe("pending");
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("servers are restarting"));

        snapshot = { instances: [report("pod-a")], restartLockHeld: false, starting: [{ instance: "pod-z", at: clock.getTime() - 60_000 }] };
        await purger().check();
        expect((await ledger.get(PLUGIN))!.state).toBe("pending");
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("pod-z is still starting"));

        // A start that never finished (its copy crashed) stops counting after a while.
        snapshot = { instances: [report("pod-a")], restartLockHeld: false, starting: [{ instance: "pod-z", at: clock.getTime() - DEFAULT_STARTING_MAX_AGE_MS - 1 }] };
        await purger().check();
        expect((await ledger.get(PLUGIN))!.state).toBe("done");
    });

    it("gives servers time to settle after uninstalling a plugin that was enabled, but not one that wasn't", async () => {
        await uninstalled({ enabled: true, requested: new Date(clock.getTime() - 60_000) });
        snapshot.instances = [report("pod-a")];
        await purger().check();
        expect((await ledger.get(PLUGIN))!.state).toBe("pending");
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("giving servers 180s to settle"));

        clock = new Date(clock.getTime() + 180_000);
        snapshot.instances = [report("pod-a")];
        await purger().check();
        expect((await ledger.get(PLUGIN))!.state).toBe("done");
    });

    it("deletes at once - on this copy alone - when there is no cache datastore to coordinate through", async () => {
        await uninstalled();
        await purger({ coordination: { configured: false, snapshot: vi.fn() } }).check();
        expect((await ledger.get(PLUGIN))!.state).toBe("done");
    });

    it("sets the purge aside when the plugin is installed again", async () => {
        await uninstalled();
        rows = [removedRow({ removed: false, enabled: true })];
        await purger().check();
        expect((await ledger.get(PLUGIN))!.state).toBe("cancelled");
        expect(await tables()).toContain("note_x_sql");
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("the plugin is installed again"));
    });

    it("deletes even when the plugin's row is gone", async () => {
        await uninstalled();
        rows = [];
        snapshot.instances = [report("pod-a")];
        await purger().check();
        const record = (await ledger.get(PLUGIN))!;
        expect(record.state).toBe("done");
        expect(record.steps.find((step) => step.step === "settings")).toEqual({ step: "settings", ok: true, note: "The plugin has no saved settings." });
        expect(clearSettings).not.toHaveBeenCalled();
    });

    it("does nothing when nothing is waiting", async () => {
        await ledger.recordInventory(PLUGIN, { version: "1", hook: false, models: [NOTE_X] });
        await purger().check();
        expect(coordination.snapshot).not.toHaveBeenCalled();
    });

    it("logs, rather than throws, when it can't read what is waiting", async () => {
        await purger({ ledger: { unfinished: async () => { throw new Error("db down"); } } as any }).check();
        expect(logger.warn).toHaveBeenCalledWith("Could not check for plugin data to delete: db down");
        await uninstalled();
        await purger({ readRows: async () => { throw new Error("rows down"); } }).check();
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("Could not delete the data of @rapidmx/notes-plugin: rows down"));
    });
});

describe("PluginPurger: exactly once, across copies and restarts", () => {
    it("deletes once when two copies look at the same moment", async () => {
        await uninstalled();
        snapshot.instances = [report("pod-a"), report("pod-b")];
        await Promise.all([purger({}, "pod-a").check(), purger({}, "pod-b").check(), purger({}, "pod-c").check()]);
        const record = (await ledger.get(PLUGIN))!;
        expect(record.state).toBe("done");
        expect(record.attempts).toBe(1);
        expect(clearSettings).toHaveBeenCalledTimes(1);
        expect(audit.mock.calls.filter(([action]) => action === PURGE_AUDIT.completed)).toHaveLength(1);
    });

    it("resumes after the copy that started the purge died, without repeating the steps it finished", async () => {
        await uninstalled({ hook: true });
        // pod-z claimed the purge, ran the hook and deleted one table, then died.
        const dead = (await ledger.claim(PLUGIN, "pod-z", new Date(clock.getTime() - 5 * 60_000)))!;
        await ledger.saveSteps(PLUGIN, dead.token, [{ step: "hook", ok: true }, { step: "data:sql:note_x_sql", ok: true, count: 2 }], new Date(clock.getTime() - 5 * 60_000));
        await sql.query("delete from note_x_sql");
        snapshot.instances = [report("pod-a")];

        await purger().check();

        const record = (await ledger.get(PLUGIN))!;
        expect(record.state).toBe("done");
        expect(record.attempts).toBe(2);
        expect(hooks.run).not.toHaveBeenCalled();
        expect(record.steps.find((step) => step.step === "data:sql:note_x_sql")).toEqual({ step: "data:sql:note_x_sql", ok: true, count: 2 });
        expect(await tables()).not.toContain("note_y_sql");
    });

    it("resumes a purge that was waiting through a restart when the server starts", async () => {
        await uninstalled();
        snapshot.instances = [report("pod-a")];
        const started = purger({ initialDelayMs: 1, checkIntervalMs: 60_000 });
        started.start();
        try {
            await vi.waitFor(async () => expect((await ledger.get(PLUGIN))!.state).toBe("done"), { timeout: 5000 });
        } finally {
            await started.stop();
        }
    });

    it("stops a run whose lease another copy took over, without writing anything more", async () => {
        await uninstalled({ hook: true });
        snapshot.instances = [report("pod-a")];
        hooks.run.mockImplementation(async () => {
            // While the hook runs, the lease is taken over.
            await store.update(PLUGIN, {}, { leaseOwner: "pod-b#stolen", leaseExpiresAt: new Date(clock.getTime() + 60_000) });
            return { ran: true };
        });
        await purger().check();
        const record = (await ledger.get(PLUGIN))!;
        expect(record.state).toBe("running");
        expect(record.leaseOwner).toBe("pod-b#stolen");
        expect(record.steps).toEqual([]);
        expect(await tables()).toContain("note_x_sql");
        expect(audit).not.toHaveBeenCalled();
    });

    it("pauses, keeping its steps, when a copy turns out to run the plugin again mid-purge", async () => {
        await uninstalled({ hook: true });
        snapshot.instances = [report("pod-a")];
        hooks.run.mockImplementation(async () => {
            // A copy that read the plugin list before the uninstall finishes starting, and loads the plugin.
            snapshot = { instances: [report("pod-a"), report("pod-b", { loaded: [{ name: PLUGIN, version: "1.2.3" }], hash: "old" })], restartLockHeld: false, starting: [] };
            return { ran: true };
        });
        await purger().check();
        const record = (await ledger.get(PLUGIN))!;
        expect(record.state).toBe("pending");
        expect(record.steps).toEqual([{ step: "hook", ok: true }]);
        expect(record.leaseOwner).toBeUndefined();
        expect(await tables()).toContain("note_x_sql");
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("Paused deleting the data"));
    });

    it("hands the purge back when the server stops mid-way, for another copy to finish", async () => {
        await uninstalled({ hook: true });
        snapshot.instances = [report("pod-a")];
        const running = purger();
        let release: () => void = () => undefined;
        hooks.run.mockImplementation(() => new Promise((resolve) => (release = () => resolve({ ran: true }))));
        const check = running.check();
        await vi.waitFor(() => expect(hooks.run).toHaveBeenCalled());
        const stopping = running.stop();
        release();
        await Promise.all([check, stopping]);
        const record = (await ledger.get(PLUGIN))!;
        expect(record.state).toBe("pending");
        expect(record.steps).toEqual([{ step: "hook", ok: true }]);
        expect(await tables()).toContain("note_x_sql");
    });

    it("keeps a reference to the running purger for the routes, and can be nudged", async () => {
        expect(getPluginPurger()).toBeUndefined();
        const p = purger();
        setPluginPurger(p);
        expect(getPluginPurger()).toBe(p);
        await uninstalled();
        snapshot.instances = [report("pod-a")];
        p.kick();
        await vi.waitFor(async () => expect((await ledger.get(PLUGIN))!.state).toBe("done"), { timeout: 5000 });
    });
});

describe("PluginPurger: a step that fails, the hook, and retrying", () => {
    it("records each step's result, runs on past a failure, keeps the settings until everything else worked, and can be retried", async () => {
        await uninstalled({ hook: true });
        snapshot.instances = [report("pod-a")];
        hooks.run.mockRejectedValueOnce(new Error("the S3 bucket is unreachable"));

        await purger().check();

        let record = (await ledger.get(PLUGIN))!;
        expect(record.state).toBe("failed");
        expect(record.error).toBe("1 of 4 steps failed. hook: the S3 bucket is unreachable");
        expect(record.steps.map((step) => [step.step, step.ok])).toEqual([
            ["hook", false],
            ["data:sql:note_x_sql", true],
            ["data:sql:note_y_sql", true],
            ["blobs", true],
        ]);
        // The tables are gone regardless, but the saved settings stay until nothing failed.
        expect(await tables()).not.toContain("note_x_sql");
        expect(clearSettings).not.toHaveBeenCalled();
        expect(audit).toHaveBeenCalledWith(PURGE_AUDIT.failed, { uid: "row-1", name: PLUGIN }, expect.objectContaining({ error: record.error }));

        // Retrying runs only the failed step, then the ones that waited for it.
        expect(await ledger.retry(PLUGIN)).toBe(true);
        hooks.run.mockClear();
        await purger().check();
        record = (await ledger.get(PLUGIN))!;
        expect(record.state).toBe("done");
        expect(hooks.run).toHaveBeenCalledTimes(1);
        expect(record.steps.map((step) => [step.step, step.ok])).toEqual([
            ["hook", true],
            ["data:sql:note_x_sql", true],
            ["data:sql:note_y_sql", true],
            ["blobs", true],
            ["settings", true],
            ["files", true],
        ]);
        expect(record.steps[1].count).toBe(2);
        expect(clearSettings).toHaveBeenCalledTimes(1);
    });

    it("stops before deleting anything when the plugin's hook throws AbortPurgeError", async () => {
        await uninstalled({ hook: true });
        snapshot.instances = [report("pod-a")];
        hooks.run.mockRejectedValueOnce(new AbortPurgeError("the customer still has a live subscription"));
        await purger().check();
        const record = (await ledger.get(PLUGIN))!;
        expect(record.state).toBe("failed");
        expect(record.error).toBe("The plugin stopped its data from being deleted: the customer still has a live subscription");
        expect(record.steps).toEqual([{ step: "hook", ok: false, error: "the customer still has a live subscription" }]);
        expect(await tables()).toContain("note_x_sql");
        expect(clearSettings).not.toHaveBeenCalled();
    });

    it("recognises an AbortPurgeError thrown by the plugin's own copy of the class", async () => {
        await uninstalled({ hook: true });
        snapshot.instances = [report("pod-a")];
        hooks.run.mockRejectedValueOnce(Object.assign(new Error("not now"), { name: "AbortPurgeError" }));
        await purger().check();
        expect((await ledger.get(PLUGIN))!.error).toBe("The plugin stopped its data from being deleted: not now");
        expect(await tables()).toContain("note_x_sql");
    });

    it("runs the hook first, with the plugin, what it owns and the server's handles, and passes its configured timeout", async () => {
        await uninstalled({ hook: true });
        snapshot.instances = [report("pod-a")];
        await purger({ config: { get: (key: string) => (key === "system:plugins:purge:hook_timeout_ms" ? 1234 : undefined) } }).check();
        expect(hooks.run).toHaveBeenCalledTimes(1);
        const [plugin, context, timeout] = hooks.run.mock.calls[0];
        expect(plugin).toEqual({ name: PLUGIN, packageVersion: "1.2.3", integrity: "sha512-x" });
        expect(context).toEqual(expect.objectContaining({ plugin: { name: PLUGIN, version: "1.2.3" }, models: [NOTE_X, NOTE_Y] }));
        expect(timeout).toBe(1234);
        // A plugin without a hook's inventory doesn't run one, and one that reports it had none says so.
        expect((await ledger.get(PLUGIN))!.steps[0]).toEqual({ step: "hook", ok: true });
        await store.remove(PLUGIN);
        await sql.synchronize();
        await uninstalled({ hook: true });
        hooks.run.mockResolvedValueOnce({ ran: false });
        await purger().check();
        expect((await ledger.get(PLUGIN))!.steps[0]).toEqual({ step: "hook", ok: true, note: "The plugin has no purge hook." });
    });

    it("fails the hook step when the plugin's version wasn't recorded", async () => {
        await uninstalled({ hook: true });
        await store.update(PLUGIN, {}, { packageVersion: null as any });
        snapshot.instances = [report("pod-a")];
        await purger().check();
        expect((await ledger.get(PLUGIN))!.steps[0]).toEqual(expect.objectContaining({ step: "hook", ok: false, error: expect.stringContaining("wasn't recorded") }));
        expect(hooks.run).not.toHaveBeenCalled();
    });

    it("refuses to delete a collection that is the server's own, whatever the plugin's inventory claims", async () => {
        await uninstalled({ models: [NOTE_X, model("Sneaky", "folder_sql")] });
        await sql.getRepository(FolderSQL).save(new FolderSQL());
        snapshot.instances = [report("pod-a")];
        await purger().check();
        const record = (await ledger.get(PLUGIN))!;
        expect(record.state).toBe("failed");
        expect(record.steps.find((step) => step.step === "data:sql:folder_sql")).toEqual({
            step: "data:sql:folder_sql",
            ok: false,
            error: expect.stringContaining("one of the server's own collections"),
        });
        expect(await sql.getRepository(FolderSQL).count()).toBe(1);
        // The plugin's own table was still deleted.
        expect(await tables()).not.toContain("note_x_sql");
    });

    it("refuses to delete a table that another plugin uses, loaded here or recorded by another copy", async () => {
        await uninstalled({ models: [NOTE_X, NOTE_Y] });
        await ledger.recordInventory("@rapidmx/other-plugin", { version: "1", hook: false, models: [NOTE_Y] });
        loaded = new Map([["@rapidmx/loaded-plugin", [NOTE_X]]]);
        snapshot.instances = [report("pod-a")];
        await purger().check();
        const record = (await ledger.get(PLUGIN))!;
        expect(record.state).toBe("failed");
        expect(record.steps.filter((step) => !step.ok).map((step) => step.error)).toEqual([expect.stringContaining("another plugin also uses it"), expect.stringContaining("another plugin also uses it")]);
        expect(await tables()).toEqual(expect.arrayContaining(["note_x_sql", "note_y_sql"]));
    });

    it("fails, deleting nothing, when no copy ever recorded what the plugin owns", async () => {
        await ledger.request(PLUGIN, { wasEnabled: false }, T0);
        snapshot.instances = [report("pod-a")];
        await purger().check();
        const record = (await ledger.get(PLUGIN))!;
        expect(record.state).toBe("failed");
        expect(record.steps[0]).toEqual({ step: "inventory", ok: false, error: expect.stringContaining("never loaded") });
        expect(clearSettings).not.toHaveBeenCalled();
    });

    it("records a failing settings step and a failing files step", async () => {
        await uninstalled();
        snapshot.instances = [report("pod-a")];
        clearSettings.mockRejectedValueOnce(new Error("row locked"));
        // A link where the package would be makes the file step refuse.
        const outside = path.join(dir, "outside-target");
        fs.mkdirSync(outside, { recursive: true });
        fs.mkdirSync(path.join(pluginsDir, "node_modules", "@rapidmx"), { recursive: true });
        const link = path.join(pluginsDir, "node_modules", "@rapidmx", "notes-plugin");
        fs.symlinkSync(outside, link, "junction");
        try {
            await purger().check();
        } finally {
            // Removes the link itself, never anything it points at.
            fs.unlinkSync(link);
        }
        const record = (await ledger.get(PLUGIN))!;
        expect(record.steps.find((step) => step.step === "settings")).toEqual({ step: "settings", ok: false, error: "row locked" });
        expect(record.steps.find((step) => step.step === "files")).toEqual({ step: "files", ok: false, error: expect.stringContaining("is a link") });
        expect(record.state).toBe("failed");
        expect(fs.existsSync(outside)).toBe(true);
    });

    it("reports a run whose end another copy already recorded", async () => {
        await uninstalled();
        snapshot.instances = [report("pod-a")];
        const wrapped: any = Object.create(ledger);
        wrapped.finish = async () => false;
        await purger({ ledger: wrapped }).check();
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("Could not record the end of deleting the data"));
        expect(audit).not.toHaveBeenCalled();
    });

    it("stops when saving a step shows the lease was lost", async () => {
        await uninstalled();
        snapshot.instances = [report("pod-a")];
        const wrapped: any = Object.create(ledger);
        wrapped.saveSteps = async () => false;
        await purger({ ledger: wrapped }).check();
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("another server took over the purge"));
        expect(audit).not.toHaveBeenCalled();
    });
});
