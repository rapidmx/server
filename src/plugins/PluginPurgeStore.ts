///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { In } from "typeorm";
import type { PluginPurgeRecord, PluginPurgeState } from "./PluginPurgeTypes.js";

/** What a record must look like for `PluginPurgeStore.update()` to apply a change to it. */
export interface PluginPurgeCondition {
    state?: PluginPurgeState | PluginPurgeState[];
    /** The claim token that must hold the lease. */
    leaseOwner?: string;
}

/**
 * Reads and writes the purge records (`PluginPurgeMongo`/`PluginPurgeSQL`), one per plugin name, on the server's own
 * datastore connection. Its one primitive that matters is `update()`: a compare-and-set that applies a change only while
 * the record still matches a condition, atomically in the database - which is what lets two server copies race for the
 * lease and exactly one win (`PluginPurgeLedger`).
 */
export class PluginPurgeStore {
    private readonly sql: boolean;

    /**
     * @param connection The server's connection for the datastore: service-core's own Mongo connection or a TypeORM
     * `DataSource`. Anything with TypeORM `options.type` other than `mongodb` is SQL.
     * @param modelClass `PluginPurgeMongo` or `PluginPurgeSQL`.
     */
    constructor(
        private readonly connection: any,
        private readonly modelClass: any,
    ) {
        const type: string | undefined = connection?.options?.type;
        this.sql = !!type && type !== "mongodb";
    }

    private get repo(): any {
        return this.connection.getRepository(this.modelClass);
    }

    /** A stored row as a record: what a database returns as `null` for an unset column is `undefined` here. */
    private toRecord(row: any): PluginPurgeRecord {
        const record: any = {};
        for (const [key, value] of Object.entries(row)) {
            if (key !== "_id" && value !== null && value !== undefined) {
                record[key] = value;
            }
        }
        record.steps ??= [];
        record.attempts ??= 0;
        record.state ??= "idle";
        for (const key of ["requestedAt", "leaseExpiresAt", "startedAt", "completedAt"]) {
            if (record[key] !== undefined && !(record[key] instanceof Date)) {
                record[key] = new Date(record[key]);
            }
        }
        return record as PluginPurgeRecord;
    }

    public async get(name: string): Promise<PluginPurgeRecord | null> {
        const row: any = this.sql ? await this.repo.findOneBy({ name }) : await this.repo.collection.findOne({ name });
        return row ? this.toRecord(row) : null;
    }

    public async list(): Promise<PluginPurgeRecord[]> {
        const rows: any[] = this.sql ? await this.repo.find() : await this.repo.collection.find({}).toArray();
        return rows.map((row) => this.toRecord(row));
    }

    /** The record for `name`, created idle when there is none. Two copies creating it at once end up with one row. */
    public async ensure(name: string): Promise<PluginPurgeRecord> {
        const existing: PluginPurgeRecord | null = await this.get(name);
        if (existing) {
            return existing;
        }
        try {
            const created: any = new this.modelClass({ name });
            if (this.sql) {
                await this.repo.insert(created);
            } else {
                await this.repo.collection.insertOne({ ...created });
            }
        } catch (err) {
            // Another copy created it first (the name is unique). Anything else shows as the record still being missing.
            const raced: PluginPurgeRecord | null = await this.get(name);
            if (!raced) {
                throw err;
            }
            return raced;
        }
        return (await this.get(name))!;
    }

    /**
     * Applies `patch` to the record of `name` only while it matches `condition`, atomically. Resolves whether it did -
     * `false` means another copy changed the record first (or there is none).
     */
    public async update(name: string, condition: PluginPurgeCondition, patch: Partial<PluginPurgeRecord>): Promise<boolean> {
        const states: PluginPurgeState[] | undefined = condition.state === undefined ? undefined : ([] as PluginPurgeState[]).concat(condition.state);
        const values: Record<string, unknown> = { ...patch };
        delete values.uid;
        delete values.name;
        if (this.sql) {
            const where: Record<string, unknown> = { name };
            if (states) {
                where.state = states.length === 1 ? states[0] : In(states);
            }
            if (condition.leaseOwner !== undefined) {
                where.leaseOwner = condition.leaseOwner;
            }
            const result: any = await this.repo.update(where, values);
            return (result?.affected ?? 0) > 0;
        }
        const filter: Record<string, unknown> = { name };
        if (states) {
            filter.state = states.length === 1 ? states[0] : { $in: states };
        }
        if (condition.leaseOwner !== undefined) {
            filter.leaseOwner = condition.leaseOwner;
        }
        const result: any = await this.repo.collection.updateOne(filter, { $set: values });
        return (result?.matchedCount ?? 0) > 0;
    }

    /** Deletes the record of `name`. */
    public async remove(name: string): Promise<void> {
        if (this.sql) {
            await this.repo.delete({ name });
        } else {
            await this.repo.collection.deleteOne({ name });
        }
    }
}
