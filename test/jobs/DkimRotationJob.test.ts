///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
// DKIM key rotation (restapi specs/dns_publishing_and_integrations.md section 6.2, server step S5). restapi's DkimRotationJob does the work and has its own
// tests; this checks the server's part: the job is registered with the other jobs of both datastores, the shipped configuration names every setting it
// and the key provider read (with restapi's defaults), and the README documents them.
import "reflect-metadata";
import fs from "fs";
import path from "path";
import { BackgroundService } from "@rapidrest/service-core";
import { load } from "js-yaml";
import semver from "semver";
import {
    DkimRotationJob,
    DEFAULT_DKIM_ROTATION_INTERVAL_DAYS,
    DEFAULT_DKIM_ROTATION_MAX_STARTS_PER_RUN,
    DEFAULT_DKIM_ROTATION_OVERLAP_DAYS,
    DEFAULT_DKIM_ROTATION_PUBLISH_GRACE_HOURS,
} from "@rapidmx/restapi";
import * as mongoJobs from "../../src/mongo/Jobs.js";
import * as sqlJobs from "../../src/sql/Jobs.js";
import { isProtectedPluginSettingKey } from "../../src/config.defaults.js";

/** The last postfix-bridge release whose dkim-sync.sh signs with one global selector and never writes <domain>.signing, so never acknowledges a switch. */
const LAST_POSTFIX_BRIDGE_WITHOUT_SELECTORS = "1.5.0";

/** The version the chart pins its postfixBridge dependency to. */
function pinnedPostfixBridge(): string {
    const chart: any = load(fs.readFileSync(path.resolve(__dirname, "../../helm/Chart.yaml"), "utf8"));
    return chart.dependencies.find((dep: any) => dep.alias === "postfixBridge").version;
}

const ROTATION_SETTINGS = ["enabled", "interval_days", "overlap_days", "publish_grace_hours", "key_bits", "max_starts_per_run"];

/** Every `mail:dkim:rotation:<name>` and `mail:jobs:dkim_rotation:<name>` key restapi's build reads. */
function restapiRotationKeys(): Set<string> {
    const keys = new Set<string>();
    const scan = (dir: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                scan(full);
            } else if (entry.name.endsWith(".js")) {
                for (const match of fs.readFileSync(full, "utf8").matchAll(/["'`](mail:(?:dkim:rotation|jobs:dkim_rotation):[a-z_]+)/g)) {
                    keys.add(match[1]);
                }
            }
        }
    };
    scan(path.resolve(__dirname, "../../node_modules/@rapidmx/restapi/dist"));
    return keys;
}

/** Scheduled rotation may be on only where the pinned MTA image can acknowledge a switch. */
function rotationExpectedOn(): boolean {
    return semver.gt(pinnedPostfixBridge(), LAST_POSTFIX_BRIDGE_WITHOUT_SELECTORS);
}

describe("DKIM rotation job registration", () => {
    it.each([
        ["mongo", mongoJobs, "DkimRotationJobMongo"],
        ["sql", sqlJobs, "DkimRotationJobSQL"],
    ])("%s Jobs.ts registers the rotation job with the server's other jobs", (_name, jobs, className) => {
        const job = (jobs as Record<string, any>)[className];
        expect(job).toBeTypeOf("function");
        expect(job.prototype).toBeInstanceOf(BackgroundService);
        expect(job.prototype).toBeInstanceOf(DkimRotationJob);
        // It works on the domains and audit entries of its own datastore.
        const instance: any = new job();
        expect(instance.domainClass).toBeTypeOf("function");
        expect(instance.auditLogClass).toBeTypeOf("function");
        expect(instance.domainClass.name).toBe(_name === "mongo" ? "DomainMongo" : "DomainSQL");
        expect(instance.auditLogClass.name).toBe(_name === "mongo" ? "AuditLogEntryMongo" : "AuditLogEntrySQL");
        // Hourly, as the spec says, until configured otherwise.
        expect(instance.schedule).toBe("0 0 * * * *");
    });

    it("keeps the rotation settings out of a plugin's reach", () => {
        expect(isProtectedPluginSettingKey("mail:jobs:dkim_rotation:schedule")).toBe(true);
        for (const name of ROTATION_SETTINGS) {
            expect(isProtectedPluginSettingKey(`mail:dkim:rotation:${name}`), name).toBe(true);
            expect(isProtectedPluginSettingKey(`mail__dkim__rotation__${name}`), name).toBe(true);
        }
    });
});

describe("DKIM rotation in the shipped configuration", () => {
    it("reads exactly the settings the server lists", () => {
        expect([...restapiRotationKeys()].sort()).toEqual(
            ["mail:jobs:dkim_rotation:schedule", ...ROTATION_SETTINGS.map((name) => `mail:dkim:rotation:${name}`)].sort()
        );
    });

    it("starts rotations on schedule only while the chart pins a postfix-bridge that acknowledges a switch", () => {
        // Under 1.5.0 a rotation started on schedule would switch the row's selector and then wait for an acknowledgement that never comes.
        expect(semver.valid(pinnedPostfixBridge())).not.toBeNull();
        for (const file of ["config.mongo.ts", "config.sql.ts"]) {
            const source = fs.readFileSync(path.resolve(__dirname, "../../src", file), "utf8");
            expect(source.includes(`enabled: ${rotationExpectedOn()},`), file).toBe(true);
        }
    });

    for (const file of ["../../src/config.mongo.js", "../../src/config.sql.js"]) {
        it(`${file} sets the documented defaults, the same as restapi's, and keeps the global selector`, async () => {
            vi.resetModules();
            const { default: conf } = await import(file);
            expect(conf.get("mail:jobs:dkim_rotation")).toEqual({ schedule: "0 0 * * * *" });
            expect(conf.get("mail:dkim:rotation")).toEqual({
                enabled: rotationExpectedOn(),
                interval_days: DEFAULT_DKIM_ROTATION_INTERVAL_DAYS,
                overlap_days: DEFAULT_DKIM_ROTATION_OVERLAP_DAYS,
                publish_grace_hours: DEFAULT_DKIM_ROTATION_PUBLISH_GRACE_HOURS,
                key_bits: 2048,
                max_starts_per_run: DEFAULT_DKIM_ROTATION_MAX_STARTS_PER_RUN,
            });
            expect(conf.get("mail:dkim:rotation:interval_days")).toBe(180);
            expect(conf.get("mail:dkim:rotation:overlap_days")).toBe(7);
            expect(conf.get("mail:dkim:rotation:publish_grace_hours")).toBe(48);
            expect(conf.get("mail:dkim:rotation:max_starts_per_run")).toBe(10);
            // The domains that were never rotated keep signing with the global selector and its directory.
            expect(conf.get("mail:dkim:key_dir")).toBe("/var/lib/rspamd/dkim");
            expect(conf.get("mail:dkim:selector")).toBe("mail");
        });

        it(`${file} lets the environment switch scheduled rotation, as text`, async () => {
            vi.resetModules();
            const saved = process.env.mail__dkim__rotation__enabled;
            process.env.mail__dkim__rotation__enabled = rotationExpectedOn() ? "false" : "true";
            try {
                const { default: conf } = await import(file);
                expect(String(conf.get("mail:dkim:rotation:enabled"))).toBe(rotationExpectedOn() ? "false" : "true");
            } finally {
                if (saved === undefined) delete process.env.mail__dkim__rotation__enabled;
                else process.env.mail__dkim__rotation__enabled = saved;
                vi.resetModules();
            }
        });
    }
});

describe("DKIM rotation in the README", () => {
    it("names the job's schedule and every rotation setting", () => {
        const readme = fs.readFileSync(path.resolve(__dirname, "../../README.md"), "utf8");
        for (const key of ["mail:jobs:dkim_rotation:schedule", ...ROTATION_SETTINGS.map((name) => `mail:dkim:rotation:${name}`)]) {
            // (not `expect(readme).toContain()`: a failure would print the whole file)
            expect(readme.includes(`\`${key}\``), key).toBe(true);
        }
    });

    it("states the shipped default of `enabled` and that rotation needs the console's REST routes, not a panel", () => {
        const readme = fs.readFileSync(path.resolve(__dirname, "../../README.md"), "utf8");
        const row = readme.split(/\r?\n/).find((line) => line.startsWith("| `mail:dkim:rotation:enabled`"));
        expect(row).toBeDefined();
        expect(row!.includes(rotationExpectedOn() ? "| `true` |" : "| `false` |")).toBe(true);
        for (const route of ["POST /mail/domains/:id/dkim/rotate", "POST /mail/domains/:id/dkim/rotation/cancel", "PUT /mail/domains/:id/dkim/rotation", "GET /mail/domains/:id/dkim/rotation"]) {
            expect(readme.includes(route), route).toBe(true);
        }
    });
});
