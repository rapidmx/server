///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { AccessControlListMongo, AccessControlListSQL, resolveCollectionName } from "@rapidrest/service-core";
import type { PluginOwnedModel } from "./PluginPurgeTypes.js";

/** Datastores no plugin's data is ever deleted from, whatever a plugin's classes claim: the access control lists. */
export const PROTECTED_DATASTORES: readonly string[] = ["acl"];

/** The collection and table names service-core itself uses, which aren't classes the server's class loader scans. */
const FRAMEWORK_MODELS: any[] = [AccessControlListMongo, AccessControlListSQL];

/** Something `connections` maps a datastore name to: a service-core `MongoConnection`, a TypeORM `DataSource`, a Redis
 * client or nothing. Anything with `get(name)` fits - `ConnectionManager.connections` is a `Map`. */
export interface DatastoreConnections {
    get(datastore: string): any;
}

/** Thrown when a collection or table isn't one this plugin may have deleted. */
export class PurgeGuardError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "PurgeGuardError";
    }
}

/** The datastore a model class is bound to (`@DataStore`), or `undefined` when it isn't a model. */
export function datastoreOf(clazz: any): string | undefined {
    return typeof clazz === "function" ? Reflect.getMetadata("rrst:datasource", clazz) : undefined;
}

/** Whether `connection` is a Mongo or a SQL connection (or neither: Redis, or no connection at all). */
export function connectionKind(connection: any): "mongo" | "sql" | undefined {
    if (!connection) {
        return undefined;
    }
    const type: string | undefined = connection.options?.type;
    if (type) {
        return type === "mongodb" ? "mongo" : "sql";
    }
    return typeof connection.collectionNameFor === "function" ? "mongo" : undefined;
}

/** The collection or table `clazz`'s records are stored in on `connection`, as that connection resolves it. */
export function collectionNameOf(connection: any, clazz: any, kind: "mongo" | "sql"): string {
    if (kind === "mongo") {
        return typeof connection?.collectionNameFor === "function" ? connection.collectionNameFor(clazz) : resolveCollectionName(clazz);
    }
    // A SQL DataSource knows the table (with its schema) once the entity is connected; before that, service-core's naming.
    return connection?.hasMetadata?.(clazz) ? connection.getMetadata(clazz).tablePath : resolveCollectionName(clazz);
}

/** How the guard compares two models: a collection or table on one datastore, ignoring case. */
export const ownedKey = (datastore: string, name: string): string => `${datastore}|${name.toLowerCase()}`;

/**
 * The models among `classes` (class name to class): what each one is stored in, on the connection of its datastore.
 * A class that isn't a model, or whose datastore isn't a connected database, is left out (and reported in `skipped`).
 */
export function describeModels(
    classes: Iterable<[string, any]>,
    connections: DatastoreConnections,
): { models: PluginOwnedModel[]; skipped: { className: string; reason: string }[] } {
    const models: PluginOwnedModel[] = [];
    const skipped: { className: string; reason: string }[] = [];
    for (const [className, clazz] of classes) {
        const datastore: string | undefined = datastoreOf(clazz);
        if (!datastore) {
            continue;
        }
        const connection: any = connections.get(datastore);
        const kind: "mongo" | "sql" | undefined = connectionKind(connection);
        if (!kind) {
            skipped.push({ className, reason: `its datastore '${datastore}' isn't a connected database` });
            continue;
        }
        models.push({ className, datastore, kind, name: collectionNameOf(connection, clazz, kind) });
    }
    return { models, skipped };
}

/**
 * Every collection and table that isn't a plugin's to delete: the classes the server registered on its own (its own
 * models and restapi's, everything not loaded from a plugin) plus the framework's access control lists.
 */
export function coreCollections(coreClasses: Iterable<[string, any]>, connections: DatastoreConnections): Set<string> {
    const found: Set<string> = new Set();
    for (const model of describeModels([...coreClasses, ...FRAMEWORK_MODELS.map((clazz): [string, any] => [clazz.name, clazz])], connections).models) {
        found.add(ownedKey(model.datastore, model.name));
    }
    // A model on a datastore that isn't connected in this process still has a name, by service-core's naming.
    for (const [, clazz] of [...coreClasses, ...FRAMEWORK_MODELS.map((c): [string, any] => [c.name, c])]) {
        const datastore: string | undefined = datastoreOf(clazz);
        if (datastore) {
            found.add(ownedKey(datastore, resolveCollectionName(clazz)));
        }
    }
    return found;
}

/** What a collection or table name may look like: no path characters, quoting or wildcards. */
const SAFE_NAME = /^[A-Za-z_][A-Za-z0-9_.$-]{0,254}$/;

/**
 * Refuses to delete `model` unless it is safe to: the datastore isn't protected, the name is a plain identifier (not a
 * MongoDB `system.` collection), and it isn't a collection the server itself or another plugin uses.
 *
 * @param guard `core`: `coreCollections()`. `others`: `ownedKey()`s of every other plugin's recorded models.
 * @throws PurgeGuardError with the reason.
 */
export function assertPurgeable(model: PluginOwnedModel, guard: { core: ReadonlySet<string>; others: ReadonlySet<string> }): void {
    const label: string = `${model.datastore} '${model.name}' (${model.className})`;
    if (PROTECTED_DATASTORES.includes(model.datastore)) {
        throw new PurgeGuardError(`Refusing to delete ${label}: the '${model.datastore}' datastore is never purged.`);
    }
    // SQL table names may carry a schema (`schema.table`); the dot is fine, but every part must be an identifier.
    if (!SAFE_NAME.test(model.name) || model.name.split(".").some((part) => part === "" ) || /^system\./i.test(model.name)) {
        throw new PurgeGuardError(`Refusing to delete ${label}: that isn't a name a plugin's model can use.`);
    }
    const key: string = ownedKey(model.datastore, model.name);
    const bare: string = ownedKey(model.datastore, model.name.split(".").pop()!);
    if (guard.core.has(key) || guard.core.has(bare)) {
        throw new PurgeGuardError(`Refusing to delete ${label}: it is one of the server's own collections, not the plugin's.`);
    }
    if (guard.others.has(key) || guard.others.has(bare)) {
        throw new PurgeGuardError(`Refusing to delete ${label}: another plugin also uses it.`);
    }
}
