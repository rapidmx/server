///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";

// Renders the real chart with `helm template` to check that global.gateway.tlsTermination: pod, where the Gateway passes TLS through
// and can't keep /internal/mta off the internet, refuses a short inline ingest secret. Skipped where `helm` isn't installed or the
// chart's dependencies haven't been fetched (`helm dependency update ./helm`).
const CHART = path.resolve(__dirname, "../../helm");
const helmAvailable = spawnSync("helm", ["version", "--short"], { stdio: "ignore" }).status === 0;
const depsAvailable = fs.existsSync(path.join(CHART, "charts")) && fs.readdirSync(path.join(CHART, "charts")).some((f) => f.endsWith(".tgz"));

const BASE = [
    "global.domain=example.com",
    "host=mail.example.com",
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

function render(...sets: string[]): { ok: boolean; out: string } {
    const args = ["template", "rapidmx", CHART, "--namespace", "rapidmx"];
    for (const s of [...BASE, ...sets]) {
        args.push("--set", s);
    }
    const res = spawnSync("helm", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    return { ok: res.status === 0, out: res.status === 0 ? res.stdout : res.stderr };
}

describe.skipIf(!helmAvailable || !depsAvailable)("chart: ingest secret with pod TLS termination", () => {
    vi.setConfig({ testTimeout: 60000 });

    it("refuses a short ingest secret when the pod terminates TLS", () => {
        const { ok, out } = render("global.mailIngestSecret=short", "global.gateway.tlsTermination=pod");
        expect(ok).toBe(false);
        expect(out).toMatch(/at least 16 characters with global\.gateway\.tlsTermination: pod/);
    });

    it("renders a long ingest secret with pod TLS, and a short one when the Gateway terminates TLS", () => {
        const pod = render("global.mailIngestSecret=" + "a".repeat(16), "global.gateway.tlsTermination=pod");
        expect(pod.ok).toBe(true);
        expect(pod.out).toContain("kind: TLSRoute");
        expect(render("global.mailIngestSecret=short").ok).toBe(true);
    });
});
