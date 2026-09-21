///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////

/**
 * Where a plugin's data deletion ("purge") stands:
 *
 * - `idle`: no purge was ever asked for. The record only holds what the plugin owns (`inventory`).
 * - `pending`: asked for at uninstall; runs once no server copy runs the plugin any more.
 * - `running`: one server copy holds the lease and is deleting.
 * - `done`: every step succeeded.
 * - `failed`: a step failed (or the plugin's `onPurge` hook aborted it); the administrator can retry.
 * - `cancelled`: the plugin was added again before the purge started.
 */
export type PluginPurgeState = "idle" | "pending" | "running" | "done" | "failed" | "cancelled";

/** The result of one purge step. A step is idempotent, so a retry runs the failed ones again. */
export interface PluginPurgeStep {
    /** `hook`, `data:<datastore>:<collection or table>`, `blobs`, `settings` or `files`. */
    step: string;
    ok: boolean;
    /** How many documents or rows the step deleted, when that applies. */
    count?: number;
    error?: string;
    /** Why a step that had nothing to do (or couldn't do more) was fine, or what was skipped. */
    note?: string;
}

/** One model class a plugin registered, and where its records live. */
export interface PluginOwnedModel {
    /** The exported class name, for messages. */
    className: string;
    /** The datastore the class is bound to (`@DataStore`). */
    datastore: string;
    /** The collection (Mongo) or table (SQL) name, as the connection resolved it when the plugin loaded. */
    name: string;
    /** The kind of connection `datastore` was when the plugin loaded. */
    kind: "mongo" | "sql";
}

/** What a plugin owns, recorded by a server copy when it loads the plugin. It only grows, so data an older version of
 * the plugin stored is found too. */
export interface PluginInventory {
    /** The plugin version that last recorded it. */
    version: string;
    /** Whether the plugin's package has a `./purge` entry with an `onPurge` hook. */
    hook: boolean;
    models: PluginOwnedModel[];
    /** ISO time. */
    updatedAt: string;
}

/** The record the purge is tracked in, one per plugin name (`PluginPurgeMongo`/`PluginPurgeSQL`). */
export interface PluginPurgeRecord {
    uid: string;
    name: string;
    displayName?: string;
    state: PluginPurgeState;
    inventory?: PluginInventory;
    /** The version, and integrity hash, of the plugin as it was uninstalled, for installing it to run its hook. */
    packageVersion?: string;
    integrity?: string;
    requestedBy?: string;
    requestedAt?: Date;
    /** Whether the plugin was enabled when it was uninstalled: some server copy may have been starting it. */
    wasEnabled?: boolean;
    leaseOwner?: string;
    leaseExpiresAt?: Date;
    startedAt?: Date;
    completedAt?: Date;
    /** How many times a purge run started. */
    attempts: number;
    steps: PluginPurgeStep[];
    error?: string;
}

/** What `GET /status` reports for a plugin's data deletion. */
export interface PluginPurgeInfo {
    uid: string;
    name: string;
    displayName?: string;
    state: Exclude<PluginPurgeState, "idle" | "cancelled">;
    requestedBy?: string;
    requestedAt?: string;
    completedAt?: string;
    steps: PluginPurgeStep[];
    error?: string;
    /** While `pending`: how many server copies still run the plugin (or haven't applied its removal), of how many report. */
    serversRunning?: number;
    serversTotal?: number;
}

/** Thrown by a plugin's `onPurge` hook to stop the purge before anything is deleted (a failing hook otherwise only
 * gets its failure recorded). Recognised by name, so a plugin needn't import it from the server. */
export class AbortPurgeError extends Error {
    public readonly abortPurge: true = true;

    constructor(message: string) {
        super(message);
        this.name = "AbortPurgeError";
    }
}

/** Whether `err` is an `AbortPurgeError`, from this module or thrown by a plugin's own copy of the class. */
export function isAbortPurge(err: unknown): boolean {
    return !!err && typeof err === "object" && ((err as any).name === "AbortPurgeError" || (err as any).abortPurge === true);
}
