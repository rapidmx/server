///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
import "reflect-metadata";
import { DiagnosticsCollector } from "../../src/diagnostics/DiagnosticsCollector.js";
import { DiagnosticsRoute as DiagnosticsRouteMongo } from "../../src/mongo/routes/DiagnosticsRoute.js";
import { DiagnosticsRoute as DiagnosticsRouteSql } from "../../src/sql/routes/DiagnosticsRoute.js";

/** Every `method path` pair the route class declares, from its handlers' `rrst:route` metadata. */
function declaredMethods(routeClass: new () => any): string[] {
    const result: string[] = [];
    for (let proto = routeClass.prototype; proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
        for (const key of Object.getOwnPropertyNames(proto)) {
            const route = Reflect.getMetadata("rrst:route", routeClass.prototype, key);
            for (const [method, path] of (route?.methods as Map<string, string> | undefined) ?? []) {
                result.push(`${method} ${path}`);
            }
        }
    }
    return result;
}

describe.each([
    ["mongo", DiagnosticsRouteMongo],
    ["sql", DiagnosticsRouteSql],
])("%s DiagnosticsRoute", (_name, routeClass) => {
    it("serves versions, runtime and metrics beside /api/admin", () => {
        expect(Reflect.getMetadata("rrst:routePaths", routeClass.prototype)).toContain("/api/admin/diagnostics");
        expect(declaredMethods(routeClass)).toEqual(expect.arrayContaining(["get /versions", "get /runtime", "get /metrics"]));
    });

    it("needs a JWT, a trusted role and an elevated token on every handler", () => {
        expect(Reflect.getMetadata("rrst:requiresElevation", routeClass.prototype)).toBeDefined();
        for (const handler of ["versions", "runtime", "metrics"]) {
            const route = Reflect.getMetadata("rrst:route", routeClass.prototype, handler);
            expect(route).toMatchObject({ authStrategies: ["jwt"], authRequired: true, requiresTrustedRole: true });
        }
    });

    it("hands each handler's work to one shared collector", async () => {
        const route: any = new routeClass();
        route.namespace = "mail";
        route.timeoutMs = "2500";
        const spies = {
            versions: vi.spyOn(DiagnosticsCollector.prototype, "versions").mockResolvedValue("v" as any),
            runtime: vi.spyOn(DiagnosticsCollector.prototype, "runtime").mockResolvedValue("r" as any),
            metrics: vi.spyOn(DiagnosticsCollector.prototype, "metrics").mockResolvedValue("m" as any),
        };
        expect(await route.versions()).toBe("v");
        expect(await route.runtime()).toBe("r");
        expect(await route.metrics()).toBe("m");
        expect(spies.versions).toHaveBeenCalledOnce();
        // One collector serves all three, so its samples (CPU rates) carry over between polls.
        expect(route.collector).toBeInstanceOf(DiagnosticsCollector);
        expect(route.collector.options).toMatchObject({ namespace: "mail", timeoutMs: 2500 });
        vi.restoreAllMocks();
    });
});
