///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import crypto from "crypto";
import type { PluginPurgeStore } from "./PluginPurgeStore.js";
import type { PluginInventory, PluginOwnedModel, PluginPurgeRecord, PluginPurgeState, PluginPurgeStep } from "./PluginPurgeTypes.js";

/** How long a server copy's claim on a purge lasts without being renewed, when not configured. */
export const DEFAULT_PURGE_LEASE_MS = 2 * 60_000;

/** Thrown when a plugin's data is being deleted right now, so it can't be added or uninstalled again until that ends. */
export class PurgeInProgressError extends Error {
    constructor(name: string) {
        super(`The data of ${name} is being deleted right now. Try again when that has finished.`);
        this.name = "PurgeInProgressError";
    }
}

/** A purge run's claim: the record as it was claimed, and the token that proves the claim in every later write. */
export interface PurgeClaim {
    token: string;
    record: PluginPurgeRecord;
}

/** The states a record can be in while nothing is deleting. */
const RESTING: PluginPurgeState[] = ["idle", "done", "failed", "cancelled", "pending"];

/** The identity of an owned model: two entries for the same collection are one. */
const modelKey = (model: PluginOwnedModel): string => `${model.datastore}|${model.name}`;

/**
 * The purge lifecycle as compare-and-set transitions over `PluginPurgeStore`. Every transition names the state it
 * expects, so however many server copies call it at once, exactly one wins each:
 *
 * ```
 * idle/done/failed/cancelled --request--> pending --claim--> running --finish--> done | failed
 *                                            |  ^               |  |
 *                                            |  +---release-----+  +--(lease lapsed)--> claimed again
 *                                            +--cancel--> cancelled
 * failed --retry--> pending
 * ```
 *
 * A claim is a lease: it lapses `leaseMs` after the last renewal, so a copy that dies mid-purge doesn't wedge the
 * deletion, and the next copy to look resumes it. Steps already recorded as done are kept and skipped.
 */
export class PluginPurgeLedger {
    constructor(
        private readonly store: PluginPurgeStore,
        private readonly leaseMs: number = DEFAULT_PURGE_LEASE_MS,
    ) {}

    public get(name: string): Promise<PluginPurgeRecord | null> {
        return this.store.get(name);
    }

    public list(): Promise<PluginPurgeRecord[]> {
        return this.store.list();
    }

    /** The records whose data still has to be deleted. */
    public async unfinished(): Promise<PluginPurgeRecord[]> {
        return (await this.store.list()).filter((record) => record.state === "pending" || record.state === "running");
    }

    /** Records what a plugin owns, adding to what earlier loads recorded. Writes nothing when it is already all there. */
    public async recordInventory(name: string, inventory: Omit<PluginInventory, "updatedAt">, now: Date = new Date()): Promise<void> {
        const record: PluginPurgeRecord = await this.store.ensure(name);
        const known: Map<string, PluginOwnedModel> = new Map((record.inventory?.models ?? []).map((model) => [modelKey(model), model]));
        let changed: boolean = !record.inventory || record.inventory.version !== inventory.version || record.inventory.hook !== inventory.hook;
        for (const model of inventory.models) {
            if (!known.has(modelKey(model))) {
                changed = true;
            }
            known.set(modelKey(model), model);
        }
        if (changed) {
            const merged: PluginInventory = { version: inventory.version, hook: inventory.hook, models: [...known.values()], updatedAt: now.toISOString() };
            await this.store.update(name, {}, { inventory: merged });
        }
    }

    /**
     * Asks for the plugin's data to be deleted once no server copy runs it. Starts a fresh purge, replacing whatever a
     * finished, failed or cancelled earlier one recorded (and re-asking for a pending one just refreshes who asked).
     *
     * @throws PurgeInProgressError while a run is under way.
     */
    public async request(
        name: string,
        details: { displayName?: string; packageVersion?: string; integrity?: string; requestedBy?: string; wasEnabled: boolean },
        now: Date = new Date(),
    ): Promise<PluginPurgeRecord> {
        await this.store.ensure(name);
        const fresh: Partial<PluginPurgeRecord> = {
            state: "pending",
            displayName: details.displayName,
            packageVersion: details.packageVersion,
            integrity: details.integrity ?? (null as any),
            requestedBy: details.requestedBy,
            requestedAt: now,
            wasEnabled: details.wasEnabled,
            leaseOwner: null as any,
            leaseExpiresAt: null as any,
            startedAt: null as any,
            completedAt: null as any,
            attempts: 0,
            steps: [],
            error: null as any,
        };
        if (!(await this.store.update(name, { state: RESTING }, fresh))) {
            throw new PurgeInProgressError(name);
        }
        return (await this.store.get(name))!;
    }

    /**
     * Cancels a pending purge, because the plugin is being added again.
     *
     * @returns `cancelled` when there was a pending purge, `none` when there was nothing to cancel.
     * @throws PurgeInProgressError while a run is under way - even one whose lease lapsed: another copy resumes it, and
     * adding the plugin again waits for that to end rather than racing it.
     */
    public async cancelPending(name: string, now: Date = new Date()): Promise<"cancelled" | "none"> {
        const record: PluginPurgeRecord | null = await this.store.get(name);
        if (record?.state === "running") {
            throw new PurgeInProgressError(name);
        }
        if (record?.state !== "pending") {
            return "none";
        }
        if (await this.store.update(name, { state: "pending" }, { state: "cancelled", completedAt: new Date(now) })) {
            return "cancelled";
        }
        // Claimed between the read and the write.
        throw new PurgeInProgressError(name);
    }

    /** Puts a purge cancelled by `cancelPending()` back, for when the plugin turned out not to be added after all. */
    public async uncancel(name: string): Promise<void> {
        await this.store.update(name, { state: "cancelled" }, { state: "pending", completedAt: null as any });
    }

    /** Whether `record`'s lease no longer holds. */
    private leaseLapsed(record: PluginPurgeRecord, now: Date): boolean {
        return record.state === "running" && (!record.leaseExpiresAt || record.leaseExpiresAt.getTime() <= now.getTime());
    }

    /**
     * Takes the lease on a pending purge - or on a running one whose lease lapsed (its copy died). At most one caller
     * gets it; the others see `null`.
     */
    public async claim(name: string, instance: string, now: Date = new Date()): Promise<PurgeClaim | null> {
        const record: PluginPurgeRecord | null = await this.store.get(name);
        if (!record || (record.state !== "pending" && !this.leaseLapsed(record, now))) {
            return null;
        }
        const token: string = `${instance}#${crypto.randomUUID()}`;
        const won: boolean = await this.store.update(
            name,
            record.state === "pending" ? { state: "pending" } : { state: "running", leaseOwner: record.leaseOwner },
            {
                state: "running",
                leaseOwner: token,
                leaseExpiresAt: new Date(now.getTime() + this.leaseMs),
                startedAt: now,
                completedAt: null as any,
                error: null as any,
                attempts: record.attempts + 1,
            },
        );
        return won ? { token, record: (await this.store.get(name))! } : null;
    }

    /** Extends the lease. `false` means it was lost (it lapsed and another copy took it, or the purge was cancelled). */
    public renew(name: string, token: string, now: Date = new Date()): Promise<boolean> {
        return this.store.update(name, { state: "running", leaseOwner: token }, { leaseExpiresAt: new Date(now.getTime() + this.leaseMs) });
    }

    /** Records the steps run so far, extending the lease. `false` when the lease was lost. */
    public saveSteps(name: string, token: string, steps: PluginPurgeStep[], now: Date = new Date()): Promise<boolean> {
        return this.store.update(name, { state: "running", leaseOwner: token }, { steps, leaseExpiresAt: new Date(now.getTime() + this.leaseMs) });
    }

    /** Ends a run as `done` (dropping the inventory, which was only there to find the data) or `failed`. */
    public finish(name: string, token: string, outcome: "done" | "failed", steps: PluginPurgeStep[], error?: string, now: Date = new Date()): Promise<boolean> {
        return this.store.update(
            name,
            { state: "running", leaseOwner: token },
            {
                state: outcome,
                steps,
                error: error ?? (null as any),
                completedAt: now,
                leaseOwner: null as any,
                leaseExpiresAt: null as any,
                ...(outcome === "done" ? { inventory: null as any } : {}),
            },
        );
    }

    /** Gives the lease back and returns the purge to pending, keeping the steps done - for a run that found it isn't
     * safe to go on (a server copy runs the plugin again). */
    public release(name: string, token: string, steps: PluginPurgeStep[]): Promise<boolean> {
        return this.store.update(name, { state: "running", leaseOwner: token }, { state: "pending", steps, leaseOwner: null as any, leaseExpiresAt: null as any });
    }

    /** Queues a failed purge to run again; the steps that succeeded are kept and skipped. */
    public retry(name: string): Promise<boolean> {
        return this.store.update(name, { state: "failed" }, { state: "pending", error: null as any, completedAt: null as any });
    }

    /** Forgets a finished, failed or cancelled purge (what it recorded no longer describes the plugin's data - it was
     * uninstalled again without deleting it). */
    public async clearOutcome(name: string): Promise<void> {
        await this.store.update(
            name,
            { state: ["done", "failed", "cancelled"] },
            {
                state: "idle",
                displayName: null as any,
                packageVersion: null as any,
                integrity: null as any,
                requestedBy: null as any,
                requestedAt: null as any,
                wasEnabled: null as any,
                startedAt: null as any,
                completedAt: null as any,
                attempts: 0,
                steps: [],
                error: null as any,
            },
        );
    }

    /** Sets a pending purge aside without a run, because the plugin is installed after all. */
    public async abandon(name: string): Promise<boolean> {
        return this.store.update(name, { state: "pending" }, { state: "cancelled", completedAt: new Date() });
    }
}
