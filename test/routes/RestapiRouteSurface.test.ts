///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
// restapi's key trust, key conflict and verification seal endpoints are declared on its base routes. The server mounts
// them through its own subclasses of restapi's concrete Mongo and SQL routes, so this checks the handlers are inherited
// at the paths the web client calls, and that the abstract model classes those handlers need are set.
import "reflect-metadata";
import { DirectoryRoute as DirectoryRouteMongo } from "../../src/mongo/routes/DirectoryRoute.js";
import { KeyLookupRoute as KeyLookupRouteMongo } from "../../src/mongo/routes/KeyLookupRoute.js";
import { MessageRoute as MessageRouteMongo } from "../../src/mongo/routes/MessageRoute.js";
import { DirectoryRoute as DirectoryRouteSql } from "../../src/sql/routes/DirectoryRoute.js";
import { KeyLookupRoute as KeyLookupRouteSql } from "../../src/sql/routes/KeyLookupRoute.js";
import { MessageRoute as MessageRouteSql } from "../../src/sql/routes/MessageRoute.js";

/** Every `method path` pair the route class declares, from its handlers' `rrst:route` metadata. */
function declaredMethods(routeClass: new () => any): string[] {
    const result: string[] = [];
    const seen = new Set<string>();
    for (let proto = routeClass.prototype; proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
        for (const key of Object.getOwnPropertyNames(proto)) {
            if (seen.has(key)) {
                continue;
            }
            seen.add(key);
            const route = Reflect.getMetadata("rrst:route", routeClass.prototype, key);
            for (const [method, path] of (route?.methods as Map<string, string> | undefined) ?? []) {
                result.push(`${method} ${path}`);
            }
        }
    }
    return result;
}

describe("restapi route surface", () => {
    it.each([
        ["mongo", KeyLookupRouteMongo],
        ["sql", KeyLookupRouteSql],
    ])("%s KeyLookupRoute serves keys/trust and keys/resolve under mail/mailboxes", (_name, routeClass) => {
        expect(Reflect.getMetadata("rrst:routePaths", routeClass.prototype)).toContain("/api/mail/mailboxes");
        const methods = declaredMethods(routeClass);
        expect(methods).toEqual(expect.arrayContaining(["post /:id/keys/trust", "post /:id/keys/resolve"]));
        expect(new routeClass().auditLogClass).toBeTypeOf("function");
    });

    it.each([
        ["mongo", MessageRouteMongo],
        ["sql", MessageRouteSql],
    ])("%s MessageRoute serves PUT /:id/verification-seal under mail/messages", (_name, routeClass) => {
        expect(Reflect.getMetadata("rrst:routePaths", routeClass.prototype)).toContain("/api/mail/messages");
        expect(declaredMethods(routeClass)).toContain("put /:id/verification-seal");
        expect(new routeClass().keyVaultClass).toBeTypeOf("function");
    });

    it.each([
        ["mongo", DirectoryRouteMongo],
        ["sql", DirectoryRouteSql],
    ])("%s DirectoryRoute serves recipient suggestions under mail/directory", (_name, routeClass) => {
        expect(Reflect.getMetadata("rrst:routePaths", routeClass.prototype)).toContain("/api/mail/directory");
        // `@Get()` declares the route's own base path as an empty path.
        expect(declaredMethods(routeClass)).toEqual(expect.arrayContaining(["get ", "get /contacts"]));
        const route: any = new routeClass();
        for (const modelClass of [route.mailboxClass, route.folderClass, route.erasureRequestClass]) {
            expect(modelClass).toBeTypeOf("function");
        }
    });
});
