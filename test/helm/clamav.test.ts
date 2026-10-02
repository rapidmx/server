///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";

// Renders the real chart with `helm template` to check that the ClamAV Deployment is only counted ready once clamd listens, and
// that a rollout keeps the old pod until then (the AV provider quarantines mail while clamd is down). Skipped where `helm` isn't
// installed or the chart's dependencies haven't been fetched, as in coturnTls.test.ts.
const CHART = path.resolve(__dirname, "../../helm");
const helmAvailable = spawnSync("helm", ["version", "--short"], { stdio: "ignore" }).status === 0;
const depsAvailable = fs.existsSync(path.join(CHART, "charts")) && fs.readdirSync(path.join(CHART, "charts")).some((f) => f.endsWith(".tgz"));

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

function render(...sets: string[]): string {
    const args = ["template", "rapidmx", CHART, "--namespace", "rapidmx"];
    for (const s of [...BASE, ...sets]) {
        args.push("--set", s);
    }
    const res = spawnSync("helm", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    expect(res.status).toBe(0);
    return res.stdout.split(String.fromCharCode(13)).join("");
}

const clamavDeployment = (out: string) => out.split(/^---$/m).find((doc) => /kind: Deployment/.test(doc) && /name: clamav\n/.test(doc)) ?? "";

/** The fields of a probe in the Deployment (the chart renders them as sorted YAML). */
function probe(clamav: string, name: string): Record<string, string> {
    const block = new RegExp(String.raw`${name}:\n\s+tcpSocket:\n\s+port: 3310\n((?:\s+\w+: \d+\n)*)`).exec(clamav)?.[1] ?? "";
    return Object.fromEntries([...block.matchAll(/(\w+): (\d+)/g)].map((m) => [m[1], m[2]]));
}

describe.skipIf(!helmAvailable || !depsAvailable)("chart: ClamAV rollout", () => {
    vi.setConfig({ testTimeout: 60000 });

    it("waits for clamd to listen before the pod is ready, and keeps the old pod until then", () => {
        const clamav = clamavDeployment(render());
        expect(clamav).toMatch(/strategy:\n\s+type: RollingUpdate\n\s+rollingUpdate:\n\s+maxSurge: 1\n\s+maxUnavailable: 0/);
        // clamd loads its signatures for minutes: about ten of startup allowance, then a readiness check on the same port.
        expect(probe(clamav, "startupProbe")).toEqual({ periodSeconds: "10", failureThreshold: "60" });
        expect(probe(clamav, "readinessProbe")).toEqual({ periodSeconds: "10", timeoutSeconds: "5", failureThreshold: "3" });
    });

    it("takes the probe timings from mail.clamav", () => {
        const clamav = clamavDeployment(render("mail.clamav.startupProbe.failureThreshold=120", "mail.clamav.readinessProbe.periodSeconds=20"));
        expect(probe(clamav, "startupProbe")).toEqual({ periodSeconds: "10", failureThreshold: "120" });
        expect(probe(clamav, "readinessProbe")).toEqual({ periodSeconds: "20", timeoutSeconds: "5", failureThreshold: "3" });
    });

    it("mounts a clamd.conf that reports an archive past clamd's limits, instead of passing it as clean", () => {
        const out = render("mail.clamav.extraConfig=AlertEncrypted yes");
        const clamav = clamavDeployment(out);
        expect(clamav).toMatch(/mountPath: \/etc\/clamav\/clamd\.conf\n\s+subPath: clamd\.conf\n\s+readOnly: true/);
        expect(clamav).toMatch(/checksum\/config: \w{64}/);
        const config = out.split(/^---$/m).find((doc) => /name: clamd-config\n/.test(doc)) ?? "";
        expect(config).toMatch(/AlertExceedsMax yes/);
        expect(config).toMatch(/LocalSocket \/tmp\/clamd\.sock\n\s+TCPSocket 3310/);
        expect(config).toMatch(/AlertEncrypted yes/);
    });
});
