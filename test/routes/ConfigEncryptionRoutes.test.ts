///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
// The server mounts restapi's configuration key, DNS provider and Integrations routes through its own subclasses of the concrete Mongo and SQL routes, and
// registers the key rotation job with its other jobs: this checks they sit at the paths the web client calls, with the model classes the handlers need.
import "reflect-metadata";
import { BackgroundService } from "@rapidrest/service-core";
import * as mongoJobs from "../../src/mongo/Jobs.js";
import * as sqlJobs from "../../src/sql/Jobs.js";
import { ConfigKeyRoute as ConfigKeyRouteMongo } from "../../src/mongo/routes/ConfigKeyRoute.js";
import { DnsProviderRoute as DnsProviderRouteMongo } from "../../src/mongo/routes/DnsProviderRoute.js";
import { IntegrationsRoute as IntegrationsRouteMongo } from "../../src/mongo/routes/IntegrationsRoute.js";
import { ConfigKeyRoute as ConfigKeyRouteSql } from "../../src/sql/routes/ConfigKeyRoute.js";
import { DnsProviderRoute as DnsProviderRouteSql } from "../../src/sql/routes/DnsProviderRoute.js";
import { IntegrationsRoute as IntegrationsRouteSql } from "../../src/sql/routes/IntegrationsRoute.js";

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

describe("configuration encryption routes and jobs", () => {
    it.each([
        ["mongo", ConfigKeyRouteMongo],
        ["sql", ConfigKeyRouteSql],
    ])("%s ConfigKeyRoute serves the key console under system/config-keys", (_name, routeClass) => {
        expect(Reflect.getMetadata("rrst:routePaths", routeClass.prototype)).toContain("/api/system/config-keys");
        expect(declaredMethods(routeClass)).toEqual(expect.arrayContaining(["get ", "post /rotate", "post /activate"]));
        const route: any = new routeClass();
        expect(route.configKeyStateClass).toBeTypeOf("function");
        expect(route.auditLogClass).toBeTypeOf("function");
    });

    it.each([
        ["mongo", DnsProviderRouteMongo],
        ["sql", DnsProviderRouteSql],
    ])("%s DnsProviderRoute serves the provider configs under system/dns-providers", (_name, routeClass) => {
        expect(Reflect.getMetadata("rrst:routePaths", routeClass.prototype)).toContain("/api/system/dns-providers");
        expect(declaredMethods(routeClass)).toEqual(expect.arrayContaining(["get /types", "post /:id/test", "post /:id/takeover"]));
        const route: any = new routeClass();
        for (const modelClass of [route.dnsProviderClass, route.domainClass, route.auditLogClass, route.dnsOperationClass, route.dnsControllerStateClass]) {
            expect(modelClass).toBeTypeOf("function");
        }
    });

    it.each([
        ["mongo", IntegrationsRouteMongo],
        ["sql", IntegrationsRouteSql],
    ])("%s IntegrationsRoute serves the settings under system/integrations", (_name, routeClass) => {
        expect(Reflect.getMetadata("rrst:routePaths", routeClass.prototype)).toContain("/api/system/integrations");
        expect(declaredMethods(routeClass)).toEqual(expect.arrayContaining(["put /:section", "post /:section/reset"]));
        const route: any = new routeClass();
        expect(route.integrationSettingsClass).toBeTypeOf("function");
        expect(route.auditLogClass).toBeTypeOf("function");
    });

    it.each([
        ["mongo", mongoJobs, "ConfigKeyRotationJobMongo"],
        ["sql", sqlJobs, "ConfigKeyRotationJobSQL"],
    ])("%s Jobs.ts registers the key rotation job with the server's other jobs", (_name, jobs, className) => {
        const job = (jobs as Record<string, any>)[className];
        expect(job).toBeTypeOf("function");
        expect(job.prototype).toBeInstanceOf(BackgroundService);
    });
});
