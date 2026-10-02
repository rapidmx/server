///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";

// Renders the real chart with `helm template` to check where coturn's TLS (on by default) gets its certificate in each way the
// chart is installed, and that the plugin's TURN URL only ever names what coturn serves. Skipped where `helm` isn't installed
// or the chart's dependencies haven't been fetched (`helm dependency update ./helm`), as in a checkout that hasn't built them.
const CHART = path.resolve(__dirname, "../../helm");
const helmAvailable = spawnSync("helm", ["version", "--short"], { stdio: "ignore" }).status === 0;
const depsAvailable = fs.existsSync(path.join(CHART, "charts")) && fs.readdirSync(path.join(CHART, "charts")).some((f) => f.endsWith(".tgz"));

// What a render without cluster access insists on (it can't read back generated secrets), plus the release's host.
const BASE = [
    "global.domain=example.com",
    "host=mail.example.com",
    "global.mailIngestSecret=x",
    "global.jwt.secret=y",
    "global.secrets.cookies=c",
    "global.secrets.sessions=s",
    "mail.escrow.auditHmacKey=k",
    "global.openbao.enabled=false",
    "mail.rspamd.controller.password=abcdefghijklmnop1",
    "coturn.auth.sharedSecret=abc123",
];

function render(...sets: string[]): { ok: boolean; out: string } {
    const args = ["template", "rapidmx", CHART, "--namespace", "rapidmx"];
    for (const s of [...BASE, ...sets]) {
        args.push("--set", s);
    }
    const res = spawnSync("helm", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    return { ok: res.status === 0, out: (res.status === 0 ? res.stdout : res.stderr).split(String.fromCharCode(13)).join("") };
}

const turnUrl = (out: string) => /mail__videoconf__turn__url: "([^"]*)"/.exec(out)?.[1];
const coturnDeployment = (out: string) => out.split(/^---$/m).find((doc) => /name: rapidmx-server-coturn\n\s+labels/.test(doc) && /kind: Deployment/.test(doc)) ?? "";

describe.skipIf(!helmAvailable || !depsAvailable)("chart: coturn TLS", () => {
    // Every render takes a few seconds (the chart has five subcharts).
    vi.setConfig({ testTimeout: 60000 });

    it("serves TLS by default with the certificate the chart issues for its host", () => {
        const { ok, out } = render();
        expect(ok).toBe(true);
        expect(turnUrl(out)).toBe("turn:mail.example.com:3478,turns:mail.example.com:5349");
        const coturn = coturnDeployment(out);
        expect(coturn).toContain("--tls-listening-port=5349");
        expect(coturn).toContain("--cert=/etc/coturn-tls/tls.crt");
        expect(coturn).toContain("--pkey=/etc/coturn-tls/tls.key");
        expect(coturn).toContain("secretName: mail.example.com-tls-cert");
        expect(coturn).toContain("name: certificate-reloader");
        expect(coturn).toContain("shareProcessNamespace: true");
        expect(coturn).not.toContain("--no-tls");
        // The Secret it mounts is the one cert-manager keeps for the host.
        expect(out).toMatch(/kind: Certificate\nmetadata:\n\s+name: mail\.example\.com\n[\s\S]*?secretName: mail\.example\.com-tls-cert/);
    });

    it("keeps the old behaviour with coturn.tls.enabled=false", () => {
        const { ok, out } = render("coturn.tls.enabled=false");
        expect(ok).toBe(true);
        expect(turnUrl(out)).toBe("turn:mail.example.com:3478");
        const coturn = coturnDeployment(out);
        expect(coturn).toContain("--no-tls");
        expect(coturn).not.toContain("--tls-listening-port");
        expect(coturn).not.toContain("certificate-reloader");
        expect(coturn).not.toContain("shareProcessNamespace");
        expect(coturn).not.toContain("coturn-tls");
    });

    it("mounts coturn.tls.existingSecret for another host name", () => {
        const { ok, out } = render("coturn.hostname=turn.example.org", "coturn.tls.existingSecret=turn-cert");
        expect(ok).toBe(true);
        expect(turnUrl(out)).toBe("turn:turn.example.org:3478,turns:turn.example.org:5349");
        const coturn = coturnDeployment(out);
        expect(coturn).toContain("secretName: turn-cert");
        expect(coturn).toContain("--realm=turn.example.org");
    });

    it("fails, saying what to set, for another host name with no certificate for it", () => {
        const { ok, out } = render("coturn.hostname=turn.example.org");
        expect(ok).toBe(false);
        expect(out).toContain("coturn.hostname is \"turn.example.org\"");
        expect(out).toContain("coturn.tls.existingSecret");
        expect(out).toContain("coturn.tls.enabled=false");
        // ... and the message's own escape hatch works.
        expect(render("coturn.hostname=turn.example.org", "coturn.tls.enabled=false").ok).toBe(true);
    });

    it("runs without TLS, and says so in the URL, when the chart issues no certificate", () => {
        for (const sets of [["global.gateway.tls=false"], ["global.domain=localhost", "host=localhost"], ["global.gateway.tls=false", "coturn.hostname=turn.example.org"]]) {
            const { ok, out } = render(...sets);
            expect(ok).toBe(true);
            expect(turnUrl(out)).toMatch(/^turn:[^,]*:3478$/);
            const coturn = coturnDeployment(out);
            expect(coturn).toContain("--no-tls");
            expect(coturn).not.toContain("--tls-listening-port");
            expect(coturn).not.toContain("certificate-reloader");
        }
    });

    it("serves TLS from an existingSecret even when the chart issues no certificate", () => {
        const { ok, out } = render("global.gateway.tls=false", "coturn.tls.existingSecret=my-cert");
        expect(ok).toBe(true);
        expect(turnUrl(out)).toBe("turn:mail.example.com:3478,turns:mail.example.com:5349");
        expect(coturnDeployment(out)).toContain("secretName: my-cert");
    });

    it("advertises the TLS port that coturn.tls.port sets, and nothing with coturn off", () => {
        expect(turnUrl(render("coturn.tls.port=5350").out)).toBe("turn:mail.example.com:3478,turns:mail.example.com:5350");
        const off = render("coturn.create=false");
        expect(off.ok).toBe(true);
        expect(turnUrl(off.out)).toBe("");
        expect(coturnDeployment(off.out)).toBe("");
    });
});

