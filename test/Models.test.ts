///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
// The server's ConnectionManager only connects the models its ClassLoader finds, and restapi's models reach it only
// through src/{mongo,sql}/Models.ts. A model restapi exports but these files don't has no SQL entity and no Mongo
// indexes, so the two sets must match exactly.
import "reflect-metadata";
import * as restapiMongo from "@rapidmx/restapi/mongo";
import * as restapiSql from "@rapidmx/restapi/sql";
import * as serverMongoModels from "../src/mongo/Models.js";
import * as serverSqlModels from "../src/sql/Models.js";

/** The names of the exported classes the server's model scan treats as models (they carry a datasource). */
function modelNames(exports: Record<string, unknown>): string[] {
    return Object.entries(exports)
        .filter(([, value]) => typeof value === "function" && Reflect.getMetadata("rrst:datasource", value) !== undefined)
        .map(([name]) => name)
        .sort();
}

describe("Models", () => {
    it.each([
        ["mongo", restapiMongo, serverMongoModels],
        ["sql", restapiSql, serverSqlModels],
    ])("src/%s/Models.ts re-exports every model class restapi exports", (_name, restapi, server) => {
        const expected: string[] = modelNames(restapi);
        // Sanity check that the detection itself works, so an empty-vs-empty comparison can't pass.
        expect(expected.length).toBeGreaterThanOrEqual(40);
        expect(modelNames(server)).toEqual(expected);
        // Nothing but models in these files - they are scanned for classes, so anything else would be registered too.
        expect(Object.keys(server).sort()).toEqual(expected);
    });
});
