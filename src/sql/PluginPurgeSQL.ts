///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ObjectDecorators } from "@rapidrest/core";
import { DocDecorators, ModelDecorators, PersistenceDecorators, SimpleEntity } from "@rapidrest/service-core";
import type { PluginInventory, PluginPurgeRecord, PluginPurgeState, PluginPurgeStep } from "../plugins/PluginPurgeTypes.js";
const { Description } = DocDecorators;
const { DataStore, Protect } = ModelDecorators;
const { Column, Entity, Index } = PersistenceDecorators;
const { Nullable } = ObjectDecorators;

/**
 * What a plugin owns in the database and where its data deletion stands (see `plugins/PluginPurger.ts`), for storage in
 * a SQL database. `PluginPurgeMongo` is the MongoDB twin. One row per plugin name; the server's own model, not restapi's,
 * so it is not in `Models.ts`.
 */
@DataStore("sql")
@Entity()
@Index("plugin_purge_name", ["name"], { unique: true })
@Description("What a plugin owns in the database, and the progress of deleting it after the plugin was uninstalled.")
@Protect(
    {
        uid: "PluginPurge",
        records: [
            { userOrRoleId: "anonymous", actions: [] },
            { userOrRoleId: ".*", actions: [] },
        ],
    },
    false,
)
export class PluginPurgeSQL extends SimpleEntity implements PluginPurgeRecord {
    @Column()
    @Description("The plugin's npm package name.")
    public name: string = "";

    @Column({ nullable: true })
    @Description("The plugin's display name when it was uninstalled.")
    @Nullable
    public displayName?: string;

    // `type: "varchar"` is required on every string-union column: the emitted design type is `Object`, which no SQL driver has.
    @Column({ type: "varchar" })
    @Description("Where the data deletion stands.")
    public state: PluginPurgeState = "idle";

    @Column({ type: "simple-json", nullable: true })
    @Description("The collections and tables the plugin's model classes use, recorded when a server copy loads it.")
    @Nullable
    public inventory?: PluginInventory;

    @Column({ nullable: true })
    @Description("The version the plugin had when it was uninstalled.")
    @Nullable
    public packageVersion?: string;

    @Column({ nullable: true })
    @Description("The integrity hash the plugin had when it was uninstalled.")
    @Nullable
    public integrity?: string;

    @Column({ nullable: true })
    @Description("The uid of the administrator who asked for the data to be deleted.")
    @Nullable
    public requestedBy?: string;

    @Column({ nullable: true })
    @Description("When the data deletion was asked for.")
    @Nullable
    public requestedAt?: Date;

    @Column({ nullable: true })
    @Description("Whether the plugin was enabled when it was uninstalled.")
    @Nullable
    public wasEnabled?: boolean;

    @Column({ nullable: true })
    @Description("The server copy currently deleting the data.")
    @Nullable
    public leaseOwner?: string;

    @Column({ nullable: true })
    @Description("When that server copy's claim lapses unless it renews it.")
    @Nullable
    public leaseExpiresAt?: Date;

    @Column({ nullable: true })
    @Description("When the current or last run started.")
    @Nullable
    public startedAt?: Date;

    @Column({ nullable: true })
    @Description("When the deletion finished (whether it succeeded or not).")
    @Nullable
    public completedAt?: Date;

    @Column()
    @Description("How many runs started.")
    public attempts: number = 0;

    @Column({ type: "simple-json" })
    @Description("The result of each step run so far.")
    public steps: PluginPurgeStep[] = [];

    @Column({ nullable: true })
    @Description("Why the deletion failed or was aborted.")
    @Nullable
    public error?: string;

    constructor(other?: Partial<PluginPurgeSQL>) {
        super(other);

        if (other) {
            this.name = other.name !== undefined ? other.name : this.name;
            this.displayName = "displayName" in other ? other.displayName : this.displayName;
            this.state = other.state !== undefined ? other.state : this.state;
            this.inventory = "inventory" in other ? other.inventory : this.inventory;
            this.packageVersion = "packageVersion" in other ? other.packageVersion : this.packageVersion;
            this.integrity = "integrity" in other ? other.integrity : this.integrity;
            this.requestedBy = "requestedBy" in other ? other.requestedBy : this.requestedBy;
            this.requestedAt = "requestedAt" in other ? other.requestedAt : this.requestedAt;
            this.wasEnabled = "wasEnabled" in other ? other.wasEnabled : this.wasEnabled;
            this.leaseOwner = "leaseOwner" in other ? other.leaseOwner : this.leaseOwner;
            this.leaseExpiresAt = "leaseExpiresAt" in other ? other.leaseExpiresAt : this.leaseExpiresAt;
            this.startedAt = "startedAt" in other ? other.startedAt : this.startedAt;
            this.completedAt = "completedAt" in other ? other.completedAt : this.completedAt;
            this.attempts = other.attempts !== undefined ? other.attempts : this.attempts;
            this.steps = other.steps !== undefined ? other.steps : this.steps;
            this.error = "error" in other ? other.error : this.error;
        }
    }
}
