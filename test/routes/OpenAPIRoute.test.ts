///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import "reflect-metadata";
import { OpenAPIRoute as MongoOpenAPIRoute } from "../../src/mongo/routes/OpenAPIRoute.js";
import { OpenAPIRoute as SqlOpenAPIRoute } from "../../src/sql/routes/OpenAPIRoute.js";

// The API description lists every route, including the admin and escrow ones, so it is only for signed-in callers.
describe.each([
    ["mongo", MongoOpenAPIRoute],
    ["sql", SqlOpenAPIRoute],
])("OpenAPIRoute (%s)", (_name, route) => {
    it.each(["getHTML", "getJSON", "getYAML"])("requires a JWT for %s, and is still the route the base class declares", (method) => {
        const metadata = Reflect.getMetadata("rrst:route", route.prototype, method);
        expect(metadata.authStrategies).toEqual(["jwt"]);
        expect(metadata.authRequired).toBe(true);
        expect([...metadata.methods.keys()]).toContain("get");
    });
});
