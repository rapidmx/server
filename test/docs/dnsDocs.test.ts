///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import fs from "fs";
import { load } from "js-yaml";
import path from "path";
import { describe, expect, it } from "vitest";

// Pins that the README and the release notes say what DNS publishing and the integrations now do (restapi specs/dns_publishing_and_integrations.md, 18.2 S11): every
// installer flag and credential variable the script has, every dns.* chart value, the openpgpkey host's new default instead of beta.46's opt-in, what --uninstall does
// and does not restore, and that the README's own links point at headings it has.
const ROOT = path.resolve(__dirname, "../..");
// Checked out with CRLF on Windows (core.autocrlf), so every file is read with LF.
const read = (file: string): string => fs.readFileSync(path.join(ROOT, file), "utf8").replace(/\r\n/g, "\n");
const README = read("README.md");
const NOTES = read("RELEASE_NOTES.md");
const SCRIPT = read("single_node_install.sh");
const VALUES = load(read("helm/values.yaml")) as Record<string, any>;

/** The release notes of the version being built, up to the first released one. */
const UNRELEASED = NOTES.slice(NOTES.indexOf("## Unreleased"), NOTES.indexOf("## v1.0.0-beta.46"));

/** The README from the heading that starts with `title` to the next heading of the same or a higher level. */
function section(title: string): string {
    const lines = README.split("\n");
    const start = lines.findIndex((l) => /^#{1,6} /.test(l) && l.replace(/^#+ /, "").startsWith(title));
    expect(start, `README has a heading starting "${title}"`).toBeGreaterThanOrEqual(0);
    const level = lines[start].match(/^#+/)![0].length;
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
        const m = lines[i].match(/^(#+) /);
        if (m && m[1].length <= level) {
            end = i;
            break;
        }
    }
    return lines.slice(start, end).join("\n");
}

/** GitHub's anchor for a heading. */
function slug(heading: string): string {
    return heading
        .trim()
        .toLowerCase()
        .replace(/`/g, "")
        .replace(/[^\p{L}\p{N}\s-]/gu, "")
        .replace(/\s/g, "-");
}

describe("the README", () => {
    it("has no link to a heading it does not have", () => {
        const slugs = new Set<string>();
        let inFence = false;
        for (const line of README.split("\n")) {
            if (line.startsWith("```")) {
                inFence = !inFence;
            } else if (!inFence && /^#{1,6} /.test(line)) {
                slugs.add(slug(line.replace(/^#+ /, "")));
            }
        }
        const missing = [...README.matchAll(/\]\(#([^)]+)\)/g)].map((m) => m[1]).filter((a) => !slugs.has(a));
        expect(missing).toEqual([]);
    });

    it("documents every DNS option of the standalone installer, each in the options table", () => {
        const options = section("3. Standalone k3s server");
        const flags = ["--openpgpkey-host", "--dns-provider", "--dns-zone", "--dns-credentials-file", "--dns-takeover", "--public-address", "--keep-dns"];
        for (const flag of flags) {
            expect(SCRIPT, `the script has ${flag}`).toContain(flag);
            expect(options, `the options table has ${flag}`).toMatch(new RegExp("^\\| `" + flag + "[ `]", "m"));
        }
    });

    it("lists each credential variable the installer reads for a provider type", () => {
        const variables = [...SCRIPT.matchAll(/echo "([A-Z][A-Z0-9_]+) (?:secret|option) /g)].map((m) => m[1]);
        expect(variables.length).toBeGreaterThanOrEqual(15);
        const options = section("3. Standalone k3s server");
        for (const variable of variables) {
            expect(options, `the installer section names ${variable}`).toContain(variable);
        }
        for (const type of ["cloudflare", "route53", "rfc2136", "google", "azure"]) {
            expect(options.toLowerCase(), `the installer section names ${type}`).toContain(type);
        }
        expect(options).toContain("--dns-credentials-file");
        expect(options, "the controller's tag, until the chart pins one").toContain("DNS_CONTROLLER_TAG");
    });

    it("serves openpgpkey.<domain> by default where it can, not as the opt-in beta.46 made it", () => {
        const row = README.split("\n").find((l) => l.startsWith("| `--openpgpkey-host"))!;
        expect(row).toBeDefined();
        expect(row).toContain("auto");
        expect(row).not.toMatch(/off by default/i);
        expect(README).not.toMatch(/openpgpkey[^\n]*opt-in|opt-in[^\n]*openpgpkey/i);
        expect(README).not.toMatch(/before turning it on/i);
    });

    it("describes every dns.* chart value, or names the group it is one of as a whole", () => {
        const missing: string[] = [];
        const walk = (node: any, trail: string[]) => {
            const dotted = trail.join(".");
            // A value is described when it is named, and a group when it is named as a group (`dns.controller` or `dns.controller.*`): naming one
            // value under it describes only that one.
            if (README.includes("`" + dotted + "`") || README.includes("`" + dotted + ".*`")) {
                return;
            }
            if (node && typeof node === "object" && !Array.isArray(node) && Object.keys(node).length > 0) {
                for (const key of Object.keys(node)) {
                    walk(node[key], [...trail, key]);
                }
            } else {
                missing.push(dotted);
            }
        };
        for (const key of Object.keys(VALUES.dns)) {
            walk(VALUES.dns[key], ["dns", key]);
        }
        expect(missing).toEqual([]);
    });

    it("does not claim rfc2136 was tested against BIND, which restapi's provider types say it was not", () => {
        expect(README).not.toMatch(/tested against BIND/i);
        const row = section("DNS Publishing")
            .split("\n")
            .find((l) => l.startsWith("| rfc2136"))!;
        expect(row).toMatch(/Not yet live-tested/);
    });

    it("does not say openpgpkey.<domain> is published only with the host on, which restapi does not gate", () => {
        const row = section("DNS Publishing")
            .split("\n")
            .find((l) => l.startsWith("| openpgpkey"))!;
        expect(row).toBeDefined();
        expect(row).toMatch(/^\| openpgpkey \|[^|]*\| Always/);
    });

    it("does not tell an operator to skip the DNS records by hand while the installer cannot publish without a controller release", () => {
        const text = section("Before you deploy");
        expect(text).not.toMatch(/MX, SPF, DKIM and DMARC records/);
        expect(text).toMatch(/SPF record once you opt/);
        expect(text).toMatch(/published release/);
    });

    it("shows the controller's tag in the installer's DNS example", () => {
        const example = section("Publishing DNS records with the installer").match(/```bash\n([\s\S]*?)```/)![1];
        expect(example).toContain("--dns-provider");
        expect(example).toContain("DNS_CONTROLLER_TAG");
    });

    it("says that --openpgpkey-host true also waits for the published record with --dns-provider", () => {
        const row = README.split("\n").find((l) => l.startsWith("| `--openpgpkey-host"))!;
        expect(row).toMatch(/with `--dns-provider`[^)]*`true` also waits/);
    });

    it("says the keyring must be backed up, not that it already is", () => {
        const text = section("Integrations Set in the Admin Console");
        expect(text).not.toMatch(/is backed up with the database/);
        expect(text).toMatch(/you must back up together with the database/);
    });

    it("says deleting a managed domain restores its root TXT values too, in the chart section", () => {
        const text = section("DNS Publishing") + section("Publishing DNS records with the installer");
        expect(text).toMatch(/or deleting the domain/);
        expect(README).not.toMatch(/is the only thing that puts its SPF/);
    });

    it("explains what is published, who owns it and how an existing record is handled", () => {
        const text = section("DNS Publishing");
        for (const needle of [
            "_rapidmx-verify",
            "allowTakeover",
            "conflict",
            "apex-txt",
            "SPF",
            "accept_legacy_apex",
            "system/dns-providers",
            "dns-provider",
            "manual",
        ]) {
            expect(text, `the DNS publishing section says ${needle}`).toContain(needle);
        }
        for (const provider of ["Cloudflare", "Route 53", "rfc2136", "Google", "Azure"]) {
            expect(text, `it names ${provider}`).toContain(provider);
        }
        expect(text, "rfc2136 cannot hold MX or SRV").toMatch(/rfc2136[^\n]*MX|MX[^\n]*rfc2136/);
    });

    it("says what --uninstall does for DNS, and that it does not restore an apex TXT set itself", () => {
        const text = section("3. Standalone k3s server");
        expect(text).toContain("--keep-dns");
        expect(text).toMatch(/--uninstall[\s\S]*DNSEndpoint|DNSEndpoint[\s\S]*--uninstall/);
        expect(text).toMatch(/apex/i);
        expect(README).not.toMatch(/restored by the installer's `--uninstall`/);
    });

    it("tells an operator to repeat the same --dns-* flags on every upgrade", () => {
        expect(section("3. Standalone k3s server")).toMatch(/same[^\n]*--dns-/i);
    });

    it("points the DNS records in Before you deploy at publishing", () => {
        expect(section("Before you deploy")).toMatch(/publish/i);
    });

    it("says how the integrations the console sets are kept and applied", () => {
        const text = section("Integrations Set in the Admin Console");
        for (const needle of ["integrations", "rapidmx:integrations:changed", "unreadable", "config-keyring", "keyring"]) {
            expect(text, `the integrations section says ${needle}`).toContain(needle);
        }
    });
});

describe("the release notes", () => {
    it("start the unreleased section with an Added, a Changed and a Fixed part", () => {
        expect(UNRELEASED).toMatch(/### Added/);
        expect(UNRELEASED).toMatch(/### Changed/);
        expect(UNRELEASED).toMatch(/### Fixed/);
    });

    it("describe the installer's DNS options", () => {
        for (const flag of ["--dns-provider", "--dns-zone", "--dns-credentials-file", "--dns-takeover", "--public-address", "--keep-dns", "--openpgpkey-host"]) {
            expect(UNRELEASED, `the unreleased notes name ${flag}`).toContain(flag);
        }
        expect(UNRELEASED).toContain("DNS_CONTROLLER_TAG");
        expect(UNRELEASED).toContain("<fullname>-dns-bootstrap");
    });

    it("say that the openpgpkey host's default changes from beta.46's opt-in, and what to do on upgrading", () => {
        const entry = UNRELEASED.split("\n").find((l) => l.includes("`mail.wkd.openpgpkeyHost.enabled` defaults to `auto`"))!;
        expect(entry).toBeDefined();
        expect(entry).toContain("beta.46");
        expect(entry).toMatch(/opt-in/);
    });

    it("announce the configuration encryption, the keyring to back up and the console's routes", () => {
        for (const needle of ["keyring", "<fullname>-config-keyring", "refuses to start", "system/config-keys", "system/dns-providers", "system/integrations", "backup"]) {
            expect(UNRELEASED.toLowerCase(), `the unreleased notes say ${needle}`).toContain(needle.toLowerCase());
        }
    });

    it("announce the DNS controller's internal API and its token", () => {
        expect(UNRELEASED).toContain("/internal/dns");
        expect(UNRELEASED).toContain("mail:dns:controller:subject");
    });

    it("no longer promise an installer for the provider as a later step", () => {
        expect(UNRELEASED).not.toMatch(/arrives with the next DNS publishing step/);
    });

    it("say that --uninstall refuses while a domain manages its apex TXT set, and that the installer does not restore it", () => {
        expect(UNRELEASED).toMatch(/--uninstall[^\n]*apex|apex[^\n]*--uninstall/);
    });

    it("keep beta.46's own entry, which describes that release", () => {
        expect(NOTES).toContain("## v1.0.0-beta.46");
        expect(NOTES).toMatch(/is now opt-in\*\*: chart value `mail\.wkd\.openpgpkeyHost\.enabled`/);
    });
});
