///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { spawnSync } from "child_process";
import fs from "fs";
import { loadAll } from "js-yaml";
import path from "path";

// The chart removes the postfix-bridge subchart's default memory limits (leaving only requests) and does it without Helm's
// "cannot overwrite table with non table" coalesce warning, which `helm lint` and `helm template` print for a null over a table.
// Skipped where `helm` isn't installed or the chart's dependencies haven't been fetched (`helm dependency update ./helm`).
const CHART = path.resolve(__dirname, "../../helm");
const helmAvailable = spawnSync("helm", ["version", "--short"], { stdio: "ignore" }).status === 0;
const depsAvailable = fs.existsSync(path.join(CHART, "charts")) && fs.readdirSync(path.join(CHART, "charts")).some((f) => f.endsWith(".tgz"));

const SETS = [
    "global.domain=example.com",
    "host=mail.example.com",
    "global.mailIngestSecret=" + "a".repeat(32),
    "global.jwt.secret=y",
    "global.secrets.cookies=c",
    "global.secrets.sessions=s",
    "mail.escrow.auditHmacKey=k",
    "configEncryption.existingSecret=keyring",
    "global.openbao.enabled=false",
    "mail.rspamd.controller.password=abcdefghijklmnop1",
    "coturn.auth.sharedSecret=abc123",
    "authserver.service.config.auth__oauth_server__keys__encryption_key=" + "0123456789abcdef".repeat(4),
    "authserver.service.config.auth__totp__encryption_key=" + "fedcba9876543210".repeat(4),
];

const run = (command: "template" | "lint") => {
    const args = command === "template" ? ["template", "rapidmx", CHART] : ["lint", CHART];
    for (const s of SETS) {
        args.push("--set", s);
    }
    return spawnSync("helm", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
};

describe.skipIf(!helmAvailable || !depsAvailable)("chart: the postfix-bridge subchart's resources", () => {
    vi.setConfig({ testTimeout: 60000 });

    it("prints no coalesce warning", () => {
        for (const command of ["template", "lint"] as const) {
            const res = run(command);
            expect(`${res.stdout}${res.stderr}`).not.toMatch(/coalesce\.go|cannot overwrite table/);
        }
    });

    it("leaves the Postfix and bridge containers with requests and no memory limit", () => {
        const docs = (loadAll(run("template").stdout) as any[]).filter((d) => d?.kind === "Deployment");
        for (const name of ["postfix", "postfix-bridge"]) {
            const resources = docs.find((d) => d.metadata.name === name)!.spec.template.spec.containers[0].resources;
            expect(resources.requests.memory).toBeTruthy();
            expect(resources.limits?.memory).toBeUndefined();
        }
    });
});
