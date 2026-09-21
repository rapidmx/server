///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ObjectDecorators } from "@rapidrest/core";
import { DocDecorators, ModelDecorators, PersistenceDecorators, SimpleMongoEntity } from "@rapidrest/service-core";
import type { PluginInventory, PluginPurgeRecord, PluginPurgeState, PluginPurgeStep } from "../plugins/PluginPurgeTypes.js";
const { Description } = DocDecorators;
const { DataStore, Protect } = ModelDecorators;
const { Column, Entity, Index } = PersistenceDecorators;
const { Nullable } = ObjectDecorators;

/**
 * What a plugin owns in the database and where its data deletion stands (see `plugins/PluginPurger.ts`), for storage in
 * MongoDB. `PluginPurgeSQL` is the SQL twin. One row per plugin name; the server's own model, not restapi's, so it is
 * not in `Models.ts`.
 */
@DataStore("mongo")
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
export class PluginPurgeMongo extends SimpleMongoEntity implements PluginPurgeRecord {
    @Column()
    @Description("The plugin's npm package name.")
    public name: string = "";

    @Column()
    @Description("The plugin's display name when it was uninstalled.")
    @Nullable
    public displayName?: string;

    @Column()
    @Description("Where the data deletion stands.")
    public state: PluginPurgeState = "idle";

    @Column()
    @Description("The collections and tables the plugin's model classes use, recorded when a server copy loads it.")
    @Nullable
    public inventory?: PluginInventory;

    @Column()
    @Description("The version the plugin had when it was uninstalled.")
    @Nullable
    public packageVersion?: string;

    @Column()
    @Description("The integrity hash the plugin had when it was uninstalled.")
    @Nullable
    public integrity?: string;

    @Column()
    @Description("The uid of the administrator who asked for the data to be deleted.")
    @Nullable
    public requestedBy?: string;

    @Column()
    @Description("When the data deletion was asked for.")
    @Nullable
    public requestedAt?: Date;

    @Column()
    @Description("Whether the plugin was enabled when it was uninstalled.")
    @Nullable
    public wasEnabled?: boolean;

    @Column()
    @Description("The server copy currently deleting the data.")
    @Nullable
    public leaseOwner?: string;

    @Column()
    @Description("When that server copy's claim lapses unless it renews it.")
    @Nullable
    public leaseExpiresAt?: Date;

    @Column()
    @Description("When the current or last run started.")
    @Nullable
    public startedAt?: Date;

    @Column()
    @Description("When the deletion finished (whether it succeeded or not).")
    @Nullable
    public completedAt?: Date;

    @Column()
    @Description("How many runs started.")
    public attempts: number = 0;

    @Column()
    @Description("The result of each step run so far.")
    public steps: PluginPurgeStep[] = [];

    @Column()
    @Description("Why the deletion failed or was aborted.")
    @Nullable
    public error?: string;

    constructor(other?: Partial<PluginPurgeMongo>) {
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
