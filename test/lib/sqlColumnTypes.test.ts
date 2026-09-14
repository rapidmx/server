///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import "reflect-metadata";
import { applySqlColumnTypes } from "../../src/lib/sqlColumnTypes.js";

function model(datasource: string | undefined): any {
    const clazz = class {};
    if (datasource) {
        Reflect.defineMetadata("rrst:datasource", datasource, clazz);
    }
    return clazz;
}

describe("applySqlColumnTypes", () => {
    const restapiModel = model("sql");
    const pluginModel = model("sql");
    const classes = [restapiModel, pluginModel, model("mongo"), model(undefined), "not a class"];

    it("passes the driver type and only the SQL datastore's model classes, restapi's and plugins' alike", async () => {
        const apply = vi.fn(async () => 7);
        expect(await applySqlColumnTypes("mysql", classes, undefined, { applySqlDriverColumnTypes: apply })).toBe(7);
        expect(apply).toHaveBeenCalledWith("mysql", [restapiModel, pluginModel]);
    });

    it("logs an error only for a MySQL-family driver when restapi doesn't provide the function", async () => {
        const logger = { error: vi.fn() };
        expect(await applySqlColumnTypes("postgres", classes, logger, {})).toBe(0);
        expect(logger.error).not.toHaveBeenCalled();
        expect(await applySqlColumnTypes("mariadb", classes, logger, {})).toBe(0);
        expect(logger.error).toHaveBeenCalledWith(expect.stringMatching(/applySqlDriverColumnTypes/));
    });
});
