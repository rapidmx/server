///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";

// Renders the real chart with `helm template` to check that plugins.uploads.* reach the server as the
// system:plugins:uploads:* settings (enabled, max_bytes). Skipped where `helm` isn't installed or the chart's dependencies haven't
// been fetched, as in clamav.test.ts.
const CHART = path.resolve(__dirname, "../../helm");
const helmAvailable = spawnSync("helm", ["version", "--short"], { stdio: "ignore" }).status === 0;
const depsAvailable = fs.existsSync(path.join(CHART, "charts")) && fs.readdirSync(path.join(CHART, "charts")).some((f) => f.endsWith(".tgz"));

const BASE = [
    "global.domain=example.com",
    "host=mail.example.com",
    "global.mailIngestSecret=0123456789abcdef0123",
    "global.jwt.secret=y",
    "global.secrets.cookies=c",
    "global.secrets.sessions=s",
    "mail.escrow.auditHmacKey=k",
    "global.openbao.enabled=false",
    "mail.rspamd.controller.password=abcdefghijklmnop1",
    "coturn.auth.sharedSecret=abc123",
    // The bundled auth-server refuses to render without cluster access unless its encryption keys are given.
    `authserver.service.config.auth__oauth_server__keys__encryption_key=${"0123456789abcdef".repeat(4)}`,
    `authserver.service.config.auth__totp__encryption_key=${"fedcba9876543210".repeat(4)}`,
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

/** The server's own ConfigMap (not the bundled auth-server's, which a subchart renders). */
const serviceConfig = (out: string) => out.split(/^---$/m).find((doc) => doc.includes("# Source: server/templates/0_config/service-config.yaml")) ?? "";

describe.skipIf(!helmAvailable || !depsAvailable)("chart: plugin uploads", () => {
    vi.setConfig({ testTimeout: 60000 });

    it("allows uploads of up to 50 MiB by default", () => {
        const config = serviceConfig(render());
        expect(config).toMatch(/system__plugins__uploads__enabled: "true"/);
        expect(config).toMatch(/system__plugins__uploads__max_bytes: "52428800"/);
    });

    it("takes the settings from plugins.uploads", () => {
        const config = serviceConfig(render("plugins.uploads.enabled=false", "plugins.uploads.maxBytes=104857600"));
        expect(config).toMatch(/system__plugins__uploads__enabled: "false"/);
        expect(config).toMatch(/system__plugins__uploads__max_bytes: "104857600"/);
    });
});
