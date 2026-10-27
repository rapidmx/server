///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { spawnSync } from "child_process";
import fs from "fs";
import { loadAll } from "js-yaml";
import path from "path";

// Renders the real chart with `helm template` to check that the OpenPGP Web Key Directory host (openpgpkey.<global.domain>) is
// opt-in: with mail.wkd.openpgpkeyHost.enabled off the name appears nowhere - an uncertifiable name on `host`'s Certificate
// keeps it from ever becoming Ready - and with it on the Certificate covers it and the Gateway listens and routes for it.
// Skipped where `helm` isn't installed or the chart's dependencies haven't been fetched (`helm dependency update ./helm`).
const CHART = path.resolve(__dirname, "../../helm");
const helmAvailable = spawnSync("helm", ["version", "--short"], { stdio: "ignore" }).status === 0;
const depsAvailable = fs.existsSync(path.join(CHART, "charts")) && fs.readdirSync(path.join(CHART, "charts")).some((f) => f.endsWith(".tgz"));

const HOST = "openpgpkey.example.com";
const ON = "mail.wkd.openpgpkeyHost.enabled=true";

const BASE = [
    "global.domain=example.com",
    "host=mail.example.com",
    "global.mailIngestSecret=" + "a".repeat(32),
    "global.jwt.secret=y",
    "global.secrets.cookies=c",
    "global.secrets.sessions=s",
    "mail.escrow.auditHmacKey=k",
    "global.openbao.enabled=false",
    "mail.rspamd.controller.password=abcdefghijklmnop1",
    "coturn.auth.sharedSecret=abc123",
    "authserver.service.config.auth__oauth_server__keys__encryption_key=" + "0123456789abcdef".repeat(4),
    "authserver.service.config.auth__totp__encryption_key=" + "fedcba9876543210".repeat(4),
];

// The ways the chart is exposed: its own Gateway terminating TLS, a shared Gateway it doesn't own (the installer's default), and
// pod-terminated TLS (a TLSRoute) on its own Gateway and on a shared one.
const VARIANTS: Record<string, string[]> = {
    "chart-owned Gateway": [],
    "chart-owned Gateway without the HTTP redirect": ["global.gateway.httpRedirect=false"],
    "shared Gateway": ["global.gateway.name=shared-gateway", "global.gateway.namespace=envoy-gateway-system"],
    "pod TLS": ["global.gateway.tlsTermination=pod"],
    "pod TLS on a shared Gateway": [
        "global.gateway.tlsTermination=pod",
        "global.gateway.name=shared-gateway",
        "global.gateway.namespace=envoy-gateway-system",
    ],
};

interface Doc {
    kind?: string;
    metadata?: { name?: string };
    spec?: any;
}

function render(...sets: string[]): string {
    const args = ["template", "rapidmx", CHART, "--namespace", "rapidmx"];
    for (const s of [...BASE, ...sets]) {
        args.push("--set", s);
    }
    const res = spawnSync("helm", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (res.status !== 0) {
        throw new Error(res.stderr);
    }
    return res.stdout;
}

function docs(out: string): Doc[] {
    return (loadAll(out) as Doc[]).filter((d) => d && typeof d === "object");
}

const serverCertificate = (all: Doc[]) => all.find((d) => d.kind === "Certificate" && d.metadata?.name === "mail.example.com");
const ownGateway = (all: Doc[]) => all.find((d) => d.kind === "Gateway" && d.metadata?.name === "rapidmx-server-gateway");
const route = (all: Doc[], kind: string, name: string) => all.find((d) => d.kind === kind && d.metadata?.name === name);
const sections = (d: Doc | undefined): string[] => (d?.spec?.parentRefs ?? []).map((p: any) => p.sectionName).filter(Boolean);

describe.skipIf(!helmAvailable || !depsAvailable)("chart: OpenPGP Web Key Directory host", () => {
    vi.setConfig({ testTimeout: 60000 });

    for (const [name, sets] of Object.entries(VARIANTS)) {
        it(`never names the host when it is off (${name})`, () => {
            const out = render(...sets);
            expect(out).not.toMatch(/openpgpkey/);
            // The server's own route on `host` (which carries /.well-known/openpgpkey) is still there.
            const all = docs(out);
            const main = route(all, sets.includes("global.gateway.tlsTermination=pod") ? "TLSRoute" : "HTTPRoute",
                sets.includes("global.gateway.tlsTermination=pod") ? "rapidmx-server-tlsroute" : "rapidmx-server-httproute");
            expect(main?.spec?.hostnames).toContain("mail.example.com");
        });
    }

    it("certifies, listens and routes for the host on a chart-owned Gateway when it is on", () => {
        const all = docs(render(ON));
        expect(serverCertificate(all)?.spec?.dnsNames).toContain(HOST);
        const listeners = ownGateway(all)?.spec?.listeners ?? [];
        const http = listeners.find((l: any) => l.name === "http-openpgpkey");
        const https = listeners.find((l: any) => l.name === "https-openpgpkey");
        expect(http).toMatchObject({ hostname: HOST, port: 80, protocol: "HTTP" });
        expect(https).toMatchObject({ hostname: HOST, port: 443, protocol: "HTTPS", tls: { mode: "Terminate" } });
        expect(https.tls.certificateRefs).toEqual([{ kind: "Secret", name: "mail.example.com-tls-cert" }]);

        // The redirect takes plain HTTP, the API route HTTPS.
        const redirect = route(all, "HTTPRoute", "rapidmx-server-httproute-redirect");
        expect(sections(redirect)).toContain("http-openpgpkey");
        expect(redirect?.spec?.hostnames).toContain(HOST);
        const api = route(all, "HTTPRoute", "rapidmx-server-httproute");
        expect(sections(api)).toContain("https-openpgpkey");
        expect(sections(api)).not.toContain("http-openpgpkey");
        expect(api?.spec?.hostnames).toContain(HOST);
    });

    it("routes plain HTTP for the host on the API route without the redirect", () => {
        const all = docs(render(ON, "global.gateway.httpRedirect=false"));
        const api = route(all, "HTTPRoute", "rapidmx-server-httproute");
        expect(sections(api)).toEqual(expect.arrayContaining(["http-openpgpkey", "https-openpgpkey"]));
        expect(route(all, "HTTPRoute", "rapidmx-server-httproute-redirect")).toBeUndefined();
    });

    it("names the host on the route of a shared Gateway, which names its own listeners", () => {
        const all = docs(render(ON, ...VARIANTS["shared Gateway"]));
        expect(serverCertificate(all)?.spec?.dnsNames).toContain(HOST);
        expect(ownGateway(all)).toBeUndefined();
        expect(route(all, "HTTPRoute", "rapidmx-server-httproute")?.spec?.hostnames).toContain(HOST);
    });

    it("passes the host's TLS through to the pod with pod TLS", () => {
        const all = docs(render(ON, "global.gateway.tlsTermination=pod"));
        expect(serverCertificate(all)?.spec?.dnsNames).toContain(HOST);
        const https = (ownGateway(all)?.spec?.listeners ?? []).find((l: any) => l.name === "https-openpgpkey");
        expect(https).toMatchObject({ hostname: HOST, protocol: "TLS", tls: { mode: "Passthrough" } });
        const tls = route(all, "TLSRoute", "rapidmx-server-tlsroute");
        expect(sections(tls)).toContain("https-openpgpkey");
        expect(tls?.spec?.hostnames).toContain(HOST);
        expect(sections(route(all, "HTTPRoute", "rapidmx-server-httproute"))).toContain("http-openpgpkey");
    });
});
