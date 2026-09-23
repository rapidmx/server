///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { computePluginStateHash, type Plugin } from "@rapidmx/restapi";
import {
    assertPurgeable,
    coreCollections,
    ownedKey,
    type DatastoreConnections,
} from "./PluginOwnedData.js";
import { deleteModelData } from "./PluginPurgeData.js";
import { deletePluginFiles } from "./PluginPurgeFiles.js";
import { blockingInstances, DEFAULT_STARTING_MAX_AGE_MS, type PurgeCoordinationSnapshot } from "./PluginPurgeCoordination.js";
import { DEFAULT_PURGE_HOOK_TIMEOUT_MS, type PluginPurgeContext, type PurgeHookRunner } from "./PluginPurgeHook.js";
import type { PluginPurgeLedger } from "./PluginPurgeLedger.js";
import { isAbortPurge, type PluginOwnedModel, type PluginPurgeRecord, type PluginPurgeStep } from "./PluginPurgeTypes.js";

/** The audit actions the purge records (restapi's `AuditAction` doesn't list them yet, so they are plain strings). */
export const PURGE_AUDIT = {
    requested: "plugin.purge_requested",
    cancelled: "plugin.purge_cancelled",
    retried: "plugin.purge_retried",
    completed: "plugin.purge_completed",
    failed: "plugin.purge_failed",
} as const;

/** How long a plugin must have been uninstalled before its data is deleted, when the plugin was enabled at the time (a
 * server copy that was starting up then can't be seen yet), when not configured. */
export const DEFAULT_PURGE_GRACE_MS = 3 * 60_000;

/** How often unfinished purges are looked at, when not configured. */
export const DEFAULT_PURGE_CHECK_MS = 30_000;

/** Why a purge can't go ahead yet. */
export type PurgeGate =
    | { ok: true }
    | {
          ok: false;
          reason: string;
          /** The plugin is installed after all: the purge no longer applies. */
          installed?: boolean;
          /** This server copy itself runs the plugin. */
          runningHere?: boolean;
          blocking?: string[];
          total?: number;
      };

export interface PluginPurgerOptions {
    /** This server copy's identity. */
    instance: string;
    config: { get(key: string): any };
    logger: any;
    ledger: PluginPurgeLedger;
    /** How long the ledger's lease lasts; the purger renews it a third of the way through. */
    leaseMs: number;
    /** Where to read the other copies' status; without a cache datastore there is nothing but this copy. */
    coordination: { configured: boolean; snapshot(): Promise<PurgeCoordinationSnapshot> };
    /** The server's connection per datastore name. */
    connections: DatastoreConnections;
    /** The classes the server registered on its own (models of the server and restapi), which are never a plugin's. */
    coreClasses: () => Iterable<[string, any]>;
    /** The plugins this copy runs, with the collections and tables of their models. */
    loadedPlugins: () => Map<string, PluginOwnedModel[]>;
    /** Every plugin row, removed ones included. */
    readRows: () => Promise<Plugin[]>;
    /** Empties the saved settings of a removed plugin's row (only while it is still removed). */
    clearSettings: (row: Plugin) => Promise<void>;
    hooks: PurgeHookRunner;
    /** What a plugin's `onPurge` hook gets besides the plugin and its models. */
    hookContext: () => Omit<PluginPurgeContext, "signal" | "plugin" | "models">;
    /** The plugin directory (`system:plugins:dir`), holding installed packages and cached UI builds. */
    pluginsDir: string;
    /** The UI build directory this copy serves, which is never deleted. */
    keepBuild?: () => string | undefined;
    /** Records an audit entry for a purge event. Never throws. */
    audit: (action: string, plugin: { uid?: string; name: string }, details: Record<string, unknown>) => Promise<void>;
    now?: () => Date;
    checkIntervalMs?: number;
    initialDelayMs?: number;
    graceMs?: number;
    hookTimeoutMs?: number;
    startingMaxAgeMs?: number;
}

/** A step of a purge and how to run it. */
interface PlannedStep {
    id: string;
    run: () => Promise<Omit<PluginPurgeStep, "step"> & { abort?: boolean }>;
    /** Runs only when every step before it succeeded. */
    last?: boolean;
}

/**
 * Deletes an uninstalled plugin's data once no server copy runs the plugin any more, on whichever copy notices first
 * and exactly once (`PluginPurgeLedger`'s lease), and again after a restart: every copy looks at the unfinished purges
 * when it starts and every `checkIntervalMs`.
 *
 * A purge goes ahead only while every check holds - `gate()`: the plugin's row is still removed; this copy doesn't run
 * it; and the other copies, from the status they report, all applied the plugin set without it and none lists it as
 * loaded (or failing to load), no rollout holds the restart lock and no copy is starting up. Anything unreadable counts
 * as "might still run". The checks are made again before every step, so a copy that comes up running the plugin
 * meanwhile stops the purge (the lease goes back and the purge waits).
 *
 * The steps, each recorded with its result and safe to run again (a retry runs only those that failed): the plugin's own
 * `onPurge` hook; every collection or table its model classes use, guarded so nothing that belongs to the server or
 * another plugin is ever touched; the plugin's saved settings; and this copy's files for it.
 */
export class PluginPurger {
    private checking?: Promise<void>;
    private timers: NodeJS.Timeout[] = [];
    private stopped: boolean = false;
    /** The last reason each waiting purge was logged for, so a wait is logged once, not every check. */
    private readonly waiting: Map<string, string> = new Map();

    constructor(private readonly options: PluginPurgerOptions) {}

    private now(): Date {
        return this.options.now?.() ?? new Date();
    }

    /** Starts looking for purges to run: once shortly after start (a purge that was waiting through a restart resumes
     * here), then periodically. */
    public start(): void {
        const { initialDelayMs = 10_000, checkIntervalMs = DEFAULT_PURGE_CHECK_MS } = this.options;
        this.stopped = false;
        const first: NodeJS.Timeout = setTimeout(() => void this.check(), initialDelayMs);
        first.unref?.();
        const periodic: NodeJS.Timeout = setInterval(() => void this.check(), checkIntervalMs);
        periodic.unref?.();
        this.timers.push(first, periodic);
    }

    /** Stops looking. A purge run in progress finishes its current step, then gives its lease back (another copy carries
     * on from the steps already recorded); it is never cut off mid-step. */
    public async stop(): Promise<void> {
        this.stopped = true;
        this.timers.forEach((timer) => clearTimeout(timer));
        this.timers = [];
        await this.checking?.catch(() => undefined);
    }

    /** Looks at unfinished purges soon (used right after one was asked for). */
    public kick(): void {
        const timer: NodeJS.Timeout = setTimeout(() => void this.check(), 0);
        timer.unref?.();
    }

    /** Looks at every unfinished purge once. Concurrent calls share one look. */
    public check(): Promise<void> {
        if (!this.checking) {
            this.checking = this.runCheck().finally(() => {
                this.checking = undefined;
            });
        }
        return this.checking;
    }

    private async runCheck(): Promise<void> {
        const { logger, ledger } = this.options;
        try {
            const records: PluginPurgeRecord[] = await ledger.unfinished();
            for (const record of records) {
                if (this.stopped) {
                    return;
                }
                await this.consider(record);
            }
        } catch (err: any) {
            logger?.warn?.(`Could not check for plugin data to delete: ${err.message}`);
        }
    }

    private async consider(record: PluginPurgeRecord): Promise<void> {
        const { logger, ledger, instance } = { ...this.options };
        try {
            const rows: Plugin[] = await this.options.readRows();
            const gate: PurgeGate = await this.gate(record, rows, { grace: true });
            if (!gate.ok) {
                if (gate.installed) {
                    if (await ledger.abandon(record.name)) {
                        logger?.warn?.(`Not deleting the data of ${record.name}: the plugin is installed again.`);
                    }
                } else if (this.waiting.get(record.name) !== gate.reason) {
                    this.waiting.set(record.name, gate.reason);
                    logger?.info?.(`Waiting to delete the data of ${record.name}: ${gate.reason}`);
                }
                return;
            }
            this.waiting.delete(record.name);
            const claim = await ledger.claim(record.name, instance, this.now());
            if (!claim) {
                return;
            }
            await this.run(claim.token, claim.record, rows.find((row) => row.name === record.name));
        } catch (err: any) {
            logger?.warn?.(`Could not delete the data of ${record.name}: ${err.message}`);
        }
    }

    /**
     * Whether it's safe to delete `record`'s plugin's data now.
     *
     * @param grace Whether to wait out `graceMs` after the uninstall of a plugin that was enabled (checked before the
     * purge starts; once it has started, later checks only look at what changed).
     */
    public async gate(record: PluginPurgeRecord, rows: Plugin[], options: { grace: boolean }): Promise<PurgeGate> {
        const row: Plugin | undefined = rows.find((candidate) => candidate.name === record.name);
        if (row && !row.removed) {
            return { ok: false, reason: "the plugin is installed.", installed: true };
        }
        if (this.options.loadedPlugins().has(record.name)) {
            return { ok: false, reason: "this server still runs the plugin.", runningHere: true };
        }
        const { graceMs = DEFAULT_PURGE_GRACE_MS, startingMaxAgeMs = DEFAULT_STARTING_MAX_AGE_MS } = this.options;
        const now: number = this.now().getTime();
        if (options.grace && record.wasEnabled && record.requestedAt && now < record.requestedAt.getTime() + graceMs) {
            return { ok: false, reason: `giving servers ${Math.round(graceMs / 1000)}s to settle after the uninstall.` };
        }
        const { coordination } = this.options;
        if (!coordination.configured) {
            // No cache datastore: this is the only server copy, and it doesn't run the plugin.
            return { ok: true };
        }
        let snapshot: PurgeCoordinationSnapshot;
        try {
            snapshot = await coordination.snapshot();
        } catch (err: any) {
            return { ok: false, reason: `the other servers' status can't be read (${err.message}), so they might still run the plugin.` };
        }
        const { blocking, total } = blockingInstances(snapshot.instances, record.name, computePluginStateHash(rows), now);
        if (blocking.length > 0) {
            return {
                ok: false,
                reason: `${blocking.length} of ${total} servers still run the plugin or haven't applied its removal (${blocking.join(", ")}).`,
                blocking,
                total,
            };
        }
        if (snapshot.restartLockHeld) {
            return { ok: false, reason: "servers are restarting to apply a plugin change." };
        }
        const starting: string[] = snapshot.starting.filter((entry) => !(now - entry.at > startingMaxAgeMs)).map((entry) => entry.instance);
        if (starting.length > 0) {
            return { ok: false, reason: `${starting.join(", ")} ${starting.length === 1 ? "is" : "are"} still starting.` };
        }
        return { ok: true };
    }

    /** Every step of `record`'s purge, in order. */
    private plan(record: PluginPurgeRecord, row: Plugin | undefined): PlannedStep[] {
        const { logger, config, connections } = this.options;
        const inventoryModels: PluginOwnedModel[] = record.inventory?.models ?? [];
        const steps: PlannedStep[] = [];

        if (record.inventory?.hook) {
            steps.push({
                id: "hook",
                run: async () => {
                    if (!record.packageVersion) {
                        return { ok: false, error: "The version the plugin had when it was uninstalled wasn't recorded, so its purge hook can't be installed." };
                    }
                    try {
                        const outcome = await this.options.hooks.run(
                            { name: record.name, packageVersion: record.packageVersion, integrity: record.integrity },
                            { ...this.options.hookContext(), plugin: { name: record.name, version: record.packageVersion }, models: inventoryModels },
                            this.options.hookTimeoutMs ?? config.get("system:plugins:purge:hook_timeout_ms") ?? DEFAULT_PURGE_HOOK_TIMEOUT_MS,
                        );
                        return outcome.ran ? { ok: true } : { ok: true, note: "The plugin has no purge hook." };
                    } catch (err: any) {
                        return { ok: false, error: err?.message ?? String(err), abort: isAbortPurge(err) };
                    }
                },
            });
        }

        if (!record.inventory) {
            steps.push({
                id: "inventory",
                run: async () => ({
                    ok: false,
                    error: "No server ever recorded which collections this plugin stores data in (it never loaded). Add the plugin again, wait for the servers to restart, then uninstall it with its data.",
                }),
            });
        }
        let guard: { core: Set<string>; others: Set<string> } | undefined;
        const guardFor = async () => {
            guard ??= { core: coreCollections(this.options.coreClasses(), connections), others: await this.otherPluginCollections(record.name) };
            return guard;
        };
        const seen: Set<string> = new Set();
        for (const model of inventoryModels) {
            const id: string = `data:${model.datastore}:${model.name}`;
            if (seen.has(id)) {
                continue;
            }
            seen.add(id);
            steps.push({
                id,
                run: async () => {
                    try {
                        assertPurgeable(model, await guardFor());
                        const result = await deleteModelData(connections.get(model.datastore), model);
                        logger?.info?.(`Deleted ${result.count} records of ${model.name} (${model.datastore}) that plugin ${record.name} stored.`);
                        return { ok: true, count: result.count, ...(result.note ? { note: result.note } : {}) };
                    } catch (err: any) {
                        return { ok: false, error: err?.message ?? String(err) };
                    }
                },
            });
        }

        steps.push({
            id: "blobs",
            run: async () => ({
                ok: true,
                note: "The server keeps no blobs under a plugin-owned prefix, so there was nothing to find; a plugin that stores blobs removes them in its purge hook.",
            }),
        });
        steps.push({
            id: "settings",
            last: true,
            run: async () => {
                try {
                    if (!row) {
                        return { ok: true, note: "The plugin has no saved settings." };
                    }
                    await this.options.clearSettings(row);
                    return { ok: true };
                } catch (err: any) {
                    return { ok: false, error: err?.message ?? String(err) };
                }
            },
        });
        steps.push({
            id: "files",
            last: true,
            run: async () => {
                try {
                    const result = await deletePluginFiles(this.options.pluginsDir, record.name, this.options.keepBuild?.());
                    return { ok: true, count: result.removed.length, ...(result.removed.length === 0 ? { note: "This server had no files for the plugin." } : {}) };
                } catch (err: any) {
                    return { ok: false, error: err?.message ?? String(err) };
                }
            },
        });
        return steps;
    }

    /** The collections and tables that other plugins - those this copy runs, and every other recorded inventory - use. */
    private async otherPluginCollections(name: string): Promise<Set<string>> {
        const others: Set<string> = new Set();
        for (const [pluginName, models] of this.options.loadedPlugins()) {
            if (pluginName !== name) {
                models.forEach((model) => others.add(ownedKey(model.datastore, model.name)));
            }
        }
        for (const record of await this.options.ledger.list()) {
            if (record.name !== name) {
                (record.inventory?.models ?? []).forEach((model) => others.add(ownedKey(model.datastore, model.name)));
            }
        }
        return others;
    }

    /** Runs a claimed purge to its end (or until it must stop: the lease was lost, or it stopped being safe). */
    private async run(token: string, claimed: PluginPurgeRecord, row: Plugin | undefined): Promise<void> {
        const { logger, ledger } = this.options;
        const name: string = claimed.name;
        const results: PluginPurgeStep[] = [...claimed.steps];
        let lost: boolean = false;
        const heartbeat: NodeJS.Timeout = setInterval(() => {
            void ledger.renew(name, token, this.now()).then((held) => {
                lost ||= !held;
            });
        }, Math.max(1, Math.floor(this.options.leaseMs / 3)));
        heartbeat.unref?.();
        logger?.info?.(`Deleting the data of the uninstalled plugin ${name} (attempt ${claimed.attempts}).`);
        try {
            let aborted: string | undefined;
            const plan: PlannedStep[] = this.plan(claimed, row);
            for (const item of plan) {
                if (results.some((entry) => entry.step === item.id && entry.ok)) {
                    continue;
                }
                if (item.last && results.some((entry) => !entry.ok && plan.some((planned) => planned.id === entry.step && !planned.last))) {
                    continue;
                }
                if (this.stopped) {
                    // The server is stopping: hand the purge back so another copy carries on.
                    await ledger.release(name, token, results);
                    return;
                }
                const proceed: "ok" | "lost" | "unsafe" = await this.mayContinue(claimed, token, () => lost);
                if (proceed === "lost") {
                    logger?.warn?.(`Stopped deleting the data of ${name}: another server took over the purge.`);
                    return;
                }
                if (proceed === "unsafe") {
                    await ledger.release(name, token, results);
                    logger?.warn?.(`Paused deleting the data of ${name}: a server may be running the plugin again. It resumes once none does.`);
                    return;
                }
                const outcome = await item.run();
                const result: PluginPurgeStep = { step: item.id, ...outcome };
                delete (result as any).abort;
                const at: number = results.findIndex((entry) => entry.step === item.id);
                if (at >= 0) {
                    results[at] = result;
                } else {
                    results.push(result);
                }
                if (!result.ok) {
                    logger?.warn?.(`Deleting the data of ${name}: step ${item.id} failed: ${result.error}`);
                }
                if (!(await ledger.saveSteps(name, token, results, this.now()))) {
                    logger?.warn?.(`Stopped deleting the data of ${name}: another server took over the purge.`);
                    return;
                }
                if (outcome.abort) {
                    aborted = result.error;
                    break;
                }
            }

            const failed: PluginPurgeStep[] = results.filter((entry) => !entry.ok);
            const error: string | undefined = aborted
                ? `The plugin stopped its data from being deleted: ${aborted}`
                : failed.length > 0
                  ? `${failed.length} of ${results.length} steps failed. ${failed[0].step}: ${failed[0].error}`
                  : undefined;
            const outcome: "done" | "failed" = error ? "failed" : "done";
            if (!(await ledger.finish(name, token, outcome, results, error, this.now()))) {
                logger?.warn?.(`Could not record the end of deleting the data of ${name}: another server took over the purge.`);
                return;
            }
            const summary = results.map(({ step, ok, count, error: why }) => ({ step, ok, ...(count !== undefined ? { count } : {}), ...(why ? { error: why } : {}) }));
            if (outcome === "done") {
                logger?.info?.(`Deleted the data of the uninstalled plugin ${name}.`);
                await this.options.audit(PURGE_AUDIT.completed, { uid: row?.uid, name }, { requestedBy: claimed.requestedBy, steps: summary });
            } else {
                logger?.warn?.(`Deleting the data of the uninstalled plugin ${name} failed: ${error}`);
                await this.options.audit(PURGE_AUDIT.failed, { uid: row?.uid, name }, { requestedBy: claimed.requestedBy, error, steps: summary });
            }
        } finally {
            clearInterval(heartbeat);
        }
    }

    /** Before a step: still ours (lease renewed), and still safe. */
    private async mayContinue(record: PluginPurgeRecord, token: string, lost: () => boolean): Promise<"ok" | "lost" | "unsafe"> {
        if (lost() || !(await this.options.ledger.renew(record.name, token, this.now()))) {
            return "lost";
        }
        const gate: PurgeGate = await this.gate(record, await this.options.readRows(), { grace: false });
        return gate.ok ? "ok" : "unsafe";
    }
}

/** The purger of this process, for the routes to nudge. Set by `PluginHost.start()`. */
let current: PluginPurger | undefined;

export function setPluginPurger(purger: PluginPurger | undefined): void {
    current = purger;
}

export function getPluginPurger(): PluginPurger | undefined {
    return current;
}
