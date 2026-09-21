///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { connectionKind } from "./PluginOwnedData.js";
import type { PluginOwnedModel } from "./PluginPurgeTypes.js";

/** MongoDB's `NamespaceNotFound`: dropping a collection that isn't there. */
const NAMESPACE_NOT_FOUND = 26;

/**
 * Deletes every document or row of one collection or table a plugin owned, then drops the collection or table. Safe to
 * run again: what is already gone counts as nothing left to do. The caller has already checked `assertPurgeable()`.
 *
 * @param connection The connection of `model.datastore`: a service-core `MongoConnection` or a TypeORM `DataSource`.
 * @returns How many documents or rows were deleted, and a note when there was nothing there.
 * @throws when the connection isn't the kind the model was recorded on, or the database refuses.
 */
export async function deleteModelData(connection: any, model: PluginOwnedModel): Promise<{ count: number; note?: string }> {
    const kind: "mongo" | "sql" | undefined = connectionKind(connection);
    if (kind !== model.kind) {
        throw new Error(
            `The datastore '${model.datastore}' is ${kind ? `a ${kind} connection` : "not a connected database"}, but ${model.className} was recorded on a ${model.kind} one.`,
        );
    }
    if (kind === "mongo") {
        const found: unknown[] = await connection.db.listCollections({ name: model.name }, { nameOnly: true }).toArray();
        if (found.length === 0) {
            return { count: 0, note: `${model.name} doesn't exist.` };
        }
        const collection: any = connection.db.collection(model.name);
        const deleted: any = await collection.deleteMany({});
        try {
            await collection.drop();
        } catch (err: any) {
            if (err?.code !== NAMESPACE_NOT_FOUND) {
                throw err;
            }
        }
        return { count: deleted?.deletedCount ?? 0 };
    }
    const runner: any = connection.createQueryRunner();
    try {
        if (!(await runner.hasTable(model.name))) {
            return { count: 0, note: `${model.name} doesn't exist.` };
        }
        const deleted: any = await connection.createQueryBuilder().delete().from(model.name).execute();
        await runner.dropTable(model.name, true);
        return { count: deleted?.affected ?? 0 };
    } finally {
        await runner.release();
    }
}
