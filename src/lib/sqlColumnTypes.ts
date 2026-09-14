///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import * as restapiSql from "@rapidmx/restapi/sql";

/** The SQL datastore name the server's models use (`@DataStore("sql")`). */
export const SQL_DATASTORE: string = "sql";

type ApplySqlDriverColumnTypes = (driverType: string | undefined, entities?: any[]) => Promise<number>;

/**
 * Widens SQL column types for MySQL/MariaDB with `@rapidmx/restapi`'s `applySqlDriverColumnTypes()` (`TEXT` ->
 * `LONGTEXT`, `simple-json` -> `LONGTEXT`, dates -> `DATETIME(3)`; a no-op on any other driver), for every class in
 * `classes` that is a model of the SQL datastore - restapi's own (src/sql/Models.ts) and every loaded plugin's. Must run
 * after the classes are loaded and before the datastore connects: `PluginClassLoader.afterLoad` in worker.sql.ts.
 *
 * Looked up on the module rather than imported by name, so the server still builds against a restapi release that
 * doesn't export it yet; on a MySQL-family driver that is logged as an error, since long values would then be
 * rejected or truncated.
 *
 * @returns The number of columns adjusted.
 */
export async function applySqlColumnTypes(
    driverType: string | undefined,
    classes: Iterable<unknown>,
    logger?: { error(msg: string): void },
    module: Record<string, unknown> = restapiSql,
): Promise<number> {
    const apply = module.applySqlDriverColumnTypes as ApplySqlDriverColumnTypes | undefined;
    if (typeof apply !== "function") {
        if (driverType === "mysql" || driverType === "mariadb") {
            logger?.error(
                "This @rapidmx/restapi has no applySqlDriverColumnTypes(): long text, JSON and millisecond dates won't fit " +
                    `the default ${driverType} column types.`,
            );
        }
        return 0;
    }
    const entities: unknown[] = [...classes].filter(
        (clazz) => typeof clazz === "function" && Reflect.getMetadata("rrst:datasource", clazz) === SQL_DATASTORE,
    );
    return await apply(driverType, entities);
}
