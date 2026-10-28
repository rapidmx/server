///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
// The server mounts restapi's DNS desired-state API for the DNS controller at /internal/dns, outside the public /api, like /internal/mta (spec 7.3): the
// handshake, the long-polled desired state, the status reports and the provider credentials. Only the controller's projected token is accepted, and a request
// that came through a proxy never is.
import "reflect-metadata";
import { DnsDesiredStateRoute as DnsDesiredStateRouteMongo } from "../../src/mongo/routes/DnsDesiredStateRoute.js";
import { DnsDesiredStateRoute as DnsDesiredStateRouteSql } from "../../src/sql/routes/DnsDesiredStateRoute.js";

const SUBJECT = "system:serviceaccount:rapidmx:mail-dns-controller";
const HANDSHAKE = { kind: "Handshake", controllerVersion: "0.1.0", apiVersions: ["dns.rapidmx.io/v1"] };

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

const request = (headers: Record<string, string> = {}, address: string = "10.42.0.7"): any => ({ headers, socket: { remoteAddress: address } });

describe.each([
    ["mongo", DnsDesiredStateRouteMongo],
    ["sql", DnsDesiredStateRouteSql],
])("%s DnsDesiredStateRoute", (_name, routeClass) => {
    /** A route with the verifier the server registers replaced by one that accepts the token "controller" for `subject`. */
    function route(subject: string = SUBJECT, tokenSubject: string = SUBJECT): any {
        const instance: any = new routeClass();
        instance.controllerSubject = subject;
        instance.tokenVerifier = {
            verify: vi.fn(async (token: string) => {
                if (token !== "controller") {
                    throw new Error("the token's signature does not verify");
                }
                return { subject: tokenSubject };
            }),
        };
        return instance;
    }

    const handshake = (instance: any, headers: Record<string, string>, address?: string) => instance.handshake(HANDSHAKE, request(headers, address), {});

    it("is mounted at /internal/dns, outside the public API", () => {
        expect(Reflect.getMetadata("rrst:routePaths", routeClass.prototype)).toEqual(["/internal/dns"]);
    });

    it("serves the handshake, the desired state, the status reports and the provider credentials", () => {
        expect(declaredMethods(routeClass)).toEqual(
            expect.arrayContaining(["post /handshake", "get /v1/desired-state", "put /v1/status", "get /v1/providers/:uid/credentials"]),
        );
        const instance: any = new routeClass();
        for (const modelClass of [
            instance.dnsProviderClass,
            instance.domainClass,
            instance.dnsOperationClass,
            instance.deploymentIdentityClass,
            instance.dnsControllerStateClass,
        ]) {
            expect(modelClass).toBeTypeOf("function");
        }
    });

    it("takes its configuration from the server: the controller's subject is mail:dns:controller:subject, empty until the chart sets it", () => {
        const instance: any = new routeClass();
        expect(instance.controllerSubject).toBe("");
        expect(instance.allowForwarded).toBe(false);
        expect(instance.trustedProxies).toEqual([]);
    });

    it("answers the controller's handshake to its projected token", async () => {
        const result = await handshake(route(), { authorization: "Bearer controller" });
        expect(result).toMatchObject({ kind: "HandshakeResult", compatible: true, selected: "dns.rapidmx.io/v1" });
    });

    it("refuses any other subject, a bad token, no token and an unset subject alike with 403", async () => {
        const forbidden = { status: 403 };
        await expect(handshake(route(SUBJECT, "system:serviceaccount:rapidmx:mail"), { authorization: "Bearer controller" })).rejects.toMatchObject(forbidden);
        await expect(handshake(route(), { authorization: "Bearer other" })).rejects.toMatchObject(forbidden);
        await expect(handshake(route(), {})).rejects.toMatchObject(forbidden);
        await expect(handshake(route(""), { authorization: "Bearer controller" })).rejects.toMatchObject(forbidden);
        const unverified = route();
        unverified.tokenVerifier = undefined;
        await expect(handshake(unverified, { authorization: "Bearer controller" })).rejects.toMatchObject(forbidden);
    });

    it("never serves a request that came through a proxy, not even to the controller's token", async () => {
        const instance = route();
        for (const header of ["x-forwarded-for", "x-forwarded-host", "x-real-ip", "forwarded"]) {
            await expect(handshake(instance, { authorization: "Bearer controller", [header]: "203.0.113.9" })).rejects.toMatchObject({ status: 403 });
        }
        // Refused before the token is looked at.
        expect(instance.tokenVerifier.verify).not.toHaveBeenCalled();
        // An internal load balancer that adds the headers is allowed only by `mail:internal:allow_forwarded`.
        instance.allowForwarded = true;
        await expect(handshake(instance, { authorization: "Bearer controller", "x-forwarded-for": "10.0.0.1" })).resolves.toMatchObject({ compatible: true });
    });

    it("guards every handler with the same check", async () => {
        const instance = route();
        const proxied = request({ authorization: "Bearer controller", "x-forwarded-for": "203.0.113.9" });
        await expect(instance.desiredState(undefined, proxied, {})).rejects.toMatchObject({ status: 403 });
        await expect(instance.providerCredentials("dns-cloudflare-1a2b3c4d", proxied, {})).rejects.toMatchObject({ status: 403 });
        await expect(instance.status({}, proxied, {})).rejects.toMatchObject({ status: 403 });
        expect(instance.tokenVerifier.verify).not.toHaveBeenCalled();
    });

    it("answers 429 to an address that presents too many wrong tokens, and still never turns the controller's own away", async () => {
        const instance = route();
        const wrong = { authorization: "Bearer wrong" };
        for (let attempt = 0; attempt < 10; attempt++) {
            await expect(handshake(instance, wrong, "198.51.100.4")).rejects.toMatchObject({ status: 403 });
        }
        await expect(handshake(instance, wrong, "198.51.100.4")).rejects.toMatchObject({ status: 429 });
        // A different address, or the right token, is unaffected.
        await expect(handshake(instance, wrong, "198.51.100.5")).rejects.toMatchObject({ status: 403 });
        await expect(handshake(instance, { authorization: "Bearer controller" }, "198.51.100.4")).resolves.toMatchObject({ compatible: true });
    });
});
