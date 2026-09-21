///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
// The plugin host end to end for uninstalling with data: a copy that runs a plugin records what it stores, a copy that
// starts after the plugin was uninstalled (a restart) deletes it - against a real SQLite database with the server's own
// connection manager, the real audit log model, and a real plugin module.
// The audit log's own persistence needs the full server's ACL wiring; what matters here is what the host records.
const recordAuditLog = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@rapidmx/restapi", async (importOriginal) => ({ ...(await importOriginal<any>()), recordAuditLog }));

import fs from "fs";
import os from "os";
import path from "path";
import { pathToFileURL } from "url";
import nconf from "nconf";
import * as uuid from "uuid";
import { AuditLogEntrySQL, PluginSQL } from "@rapidmx/restapi/sql";
import { ConnectionManager, ObjectFactory } from "@rapidrest/service-core";
import { PluginHost } from "../../src/plugins/PluginHost.js";
import { findAllPlugins, pluginRepository } from "../../src/plugins/PluginStateStore.js";
import { PluginPurgeLedger } from "../../src/plugins/PluginPurgeLedger.js";
import { PluginPurgeStore } from "../../src/plugins/PluginPurgeStore.js";
import { getPluginPurger, PURGE_AUDIT } from "../../src/plugins/PluginPurger.js";
import { PluginPurgeSQL } from "../../src/sql/PluginPurgeSQL.js";

const PLUGIN = "@rapidmx/notes-plugin";
const MANIFEST = { apiVersion: 1, displayName: "Notes", settings: [{ key: "notes:greeting", label: "Greeting", type: "string", default: "hi" }] };
const logger: any = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => logger, log: vi.fn() };

let dir: string;
let base: string;
let objectFactory: ObjectFactory;
let manager: ConnectionManager;
let sql: any;
let hosts: PluginHost[];
const hookRun = vi.fn(async () => ({ ran: true }));

function configWith(values: Record<string, any>) {
    const conf = new nconf.Provider();
    conf.use("memory");
    conf.defaults(values);
    return conf;
}

beforeAll(async () => {
    dir = path.join(process.cwd(), `tmp-host-purge-${uuid.v4()}`);
    base = path.join(dir, "base");
    fs.mkdirSync(base, { recursive: true });
    // The plugin: one model (with a real table), no routes.
    const packageDir = path.join(dir, "plugin");
    fs.mkdirSync(packageDir, { recursive: true });
    fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({ name: PLUGIN, version: "1.2.3", exports: { "./sql": "./sql.mjs", "./purge": "./purge.mjs" } }));
    fs.writeFileSync(
        path.join(packageDir, "sql.mjs"),
        `import "reflect-metadata";
export class NoteSQL {}
Reflect.defineMetadata("rrst:datasource", "sql", NoteSQL);
Reflect.defineMetadata("rrst:entityOptions", { name: "hostnote_sql" }, NoteSQL);
`,
    );
    fs.writeFileSync(path.join(packageDir, "purge.mjs"), "export async function onPurge() {}\n");

    const datastores = { sql: { type: "better-sqlite3", host: "localhost", database: path.join(dir, "host.db"), synchronize: true } };
    objectFactory = new ObjectFactory(configWith({ datastores }), logger);
    manager = await objectFactory.newInstance(ConnectionManager, { name: "host-purge" });
    await manager.connect(datastores, new Map<string, any>([["PluginSQL", PluginSQL], ["PluginPurgeSQL", PluginPurgeSQL], ["AuditLogEntrySQL", AuditLogEntrySQL]]));
    sql = manager.connections.get("sql");
    // The plugin's table, which its model would have created when the server connected it.
    await sql.query("create table hostnote_sql (uid varchar primary key, label varchar)");
    await sql.query("insert into hostnote_sql values ('1', 'a'), ('2', 'b')");
});

afterAll(async () => {
    await manager.disconnect();
    await objectFactory.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
    hosts = [];
    vi.clearAllMocks();
});

afterEach(async () => {
    for (const host of hosts) {
        await host.stop({ shutdown: true });
    }
    expect(getPluginPurger()).toBeUndefined();
});

const installedPlugin = () => ({
    name: PLUGIN,
    version: "1.2.3",
    manifest: MANIFEST,
    entryUrl: pathToFileURL(path.join(dir, "plugin", "sql.mjs")).href,
    packageDir: path.join(dir, "plugin"),
});

/** Starts a server copy the way the worker does, over the shared database. */
async function startCopy(options: { rows: any[]; installs: boolean; instance: string; coordination?: any }): Promise<PluginHost> {
    const purgeHooks = { run: hookRun };
    const config = configWith({
        base_path: base,
        datastores: { cache: {} },
        system: { plugins: { instance_id: options.instance, dir: path.join(dir, `plugins-${options.instance}`), purge: { initial_delay_ms: 1, check_ms: 25, grace_ms: 0 } } },
    });
    const store: any = { loadAndSeed: async () => options.rows };
    const installer: any = { install: vi.fn(async () => ({ installed: options.installs ? [installedPlugin()] : [], errors: [] })) };
    const host = await PluginHost.prepare({
        config,
        logger,
        datastore: "sql",
        pluginClass: PluginSQL,
        appRoot: process.cwd(),
        store,
        installer,
        purge: { purgeClass: PluginPurgeSQL, auditLogClass: AuditLogEntrySQL },
        purgeHooks,
        purgeCoordination: options.coordination ?? { configured: false, snapshot: async () => ({ instances: [], restartLockHeld: false, starting: [] }) },
    });
    hosts.push(host);
    await host.classLoader.load();
    await host.start(objectFactory, async () => undefined);
    return host;
}

const row = (extra: Record<string, unknown> = {}) => ({ uid: "row-1", name: PLUGIN, packageVersion: "1.2.3", enabled: true, settings: { "notes:greeting": "hello" }, manifest: MANIFEST, ...extra });

describe("PluginHost: deleting an uninstalled plugin's data", () => {
    it("records what a running plugin stores, then a copy that starts after its uninstall deletes it", async () => {
        const ledger = new PluginPurgeLedger(new PluginPurgeStore(sql, PluginPurgeSQL));
        // The plugin's row, as the plugin route keeps it.
        await pluginRepository(sql, PluginSQL).save(new PluginSQL(row()) as any);

        // A copy running the plugin records its models and whether it has a hook.
        const running = await startCopy({ rows: [row()], installs: true, instance: "pod-a" });
        expect((await ledger.get(PLUGIN))!.inventory).toEqual(
            expect.objectContaining({ version: "1.2.3", hook: true, models: [{ className: "NoteSQL", datastore: "sql", kind: "sql", name: "hostnote_sql" }] }),
        );
        expect(getPluginPurger()).toBeDefined();

        // The administrator uninstalls it with its data; this copy still runs it, so nothing is deleted.
        const removed = row({ enabled: false, removed: true });
        await sql.getRepository(PluginSQL).update({ uid: "row-1" }, { enabled: false, removed: true });
        await ledger.request(PLUGIN, { displayName: "Notes", packageVersion: "1.2.3", requestedBy: "admin-1", wasEnabled: true }, new Date(Date.now() - 60_000));
        await new Promise((resolve) => setTimeout(resolve, 150));
        expect((await ledger.get(PLUGIN))!.state).toBe("pending");
        expect(await sql.query("select count(*) as n from hostnote_sql")).toEqual([{ n: 2 }]);
        await running.stop();

        // The copy restarts into the plugin set without it: it finds the purge waiting and does it.
        await startCopy({ rows: [removed], installs: false, instance: "pod-a" });
        await vi.waitFor(async () => expect((await ledger.get(PLUGIN))!.state).toBe("done"), { timeout: 10_000 });

        const record = (await ledger.get(PLUGIN))!;
        expect(record.steps.map((step) => [step.step, step.ok])).toEqual([
            ["hook", true],
            ["data:sql:hostnote_sql", true],
            ["blobs", true],
            ["settings", true],
            ["files", true],
        ]);
        expect(record.steps[1].count).toBe(2);
        // The hook got the plugin as it was uninstalled, and what the purge deletes after it.
        expect(hookRun).toHaveBeenCalledTimes(1);
        const [hookPlugin, hookContext] = hookRun.mock.calls[0] as any[];
        expect(hookPlugin).toEqual({ name: PLUGIN, packageVersion: "1.2.3", integrity: undefined });
        expect(hookContext.models).toEqual([expect.objectContaining({ name: "hostnote_sql" })]);
        expect(hookContext.connection("sql")).toBe(sql);
        const tables = (await sql.query("select name from sqlite_master where type = 'table'")).map((t: any) => t.name);
        expect(tables).not.toContain("hostnote_sql");
        expect(tables).toEqual(expect.arrayContaining(["plugin_sql", "plugin_purge_sql", "audit_log_entry_sql"]));

        // The saved settings are gone but the removed row stays, so the default plugin list can't add the plugin again.
        const [saved] = await findAllPlugins(pluginRepository(sql, PluginSQL));
        expect(saved).toEqual(expect.objectContaining({ name: PLUGIN, removed: true, settings: {} }));

        // It's in the audit log, by the system (no request, no actor) with who asked for it.
        expect(recordAuditLog).toHaveBeenCalledTimes(1);
        const [factory, auditClass, caller, entry] = recordAuditLog.mock.calls[0] as any[];
        expect(factory).toBe(objectFactory);
        expect(auditClass).toBe(AuditLogEntrySQL);
        expect(caller.user).toBeUndefined();
        expect(entry).toEqual(expect.objectContaining({ action: PURGE_AUDIT.completed, targetType: "Plugin", targetUid: "row-1" }));
        expect(entry.details).toEqual(expect.objectContaining({ name: PLUGIN, requestedBy: "admin-1" }));
    }, 30_000);

    it("does nothing without the purge model, and reports when it can't start", async () => {
        const config = configWith({ base_path: base, datastores: { cache: {} }, system: { plugins: { dir: path.join(dir, "plugins-none") } } });
        const installer: any = { install: async () => ({ installed: [], errors: [] }) };
        const host = await PluginHost.prepare({ config, logger, datastore: "sql", pluginClass: PluginSQL, appRoot: process.cwd(), store: { loadAndSeed: async () => [] } as any, installer });
        hosts.push(host);
        await host.start(objectFactory, async () => undefined);
        expect(getPluginPurger()).toBeUndefined();

        const broken = await PluginHost.prepare({
            config,
            logger,
            datastore: "sql",
            pluginClass: PluginSQL,
            appRoot: process.cwd(),
            store: { loadAndSeed: async () => [] } as any,
            installer,
            purge: { purgeClass: PluginPurgeSQL, auditLogClass: AuditLogEntrySQL },
        });
        hosts.push(broken);
        await broken.start({ getInstance: () => undefined } as any, async () => undefined);
        expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/Deleting uninstalled plugins' data is unavailable/));
        expect(getPluginPurger()).toBeUndefined();
    });
});
