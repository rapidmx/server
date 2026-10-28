///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { spawn, spawnSync } from "child_process";
import fs from "fs";
import { load, loadAll } from "js-yaml";
import os from "os";
import path from "path";
import { BASH, bashAvailable, INSTALLERS, ROOT, runInstaller, type Run } from "../helpers/installerHarness";

// Runs the DNS functions of single_node_install.sh (restapi specs/dns_publishing_and_integrations.md, 12 and 9.5) under bash, with kubectl, curl and ip replaced by
// stubs that record what they were asked to do (test/fixtures/installer/dns-stubs.sh): the flags and their checks, the credentials from a file or the environment, the
// provider config handed to the chart, the Secret the server reads it from, the CRD, the public addresses, the two-step openpgpkey host, the final message, and the
// uninstall with --keep-dns. Skipped where there's no bash.
const INSTALLER = "single_node_install.sh";
const SCRIPT = INSTALLERS[INSTALLER];

/** What the installer has set by the time its DNS functions run. */
const DEFAULTS: Record<string, string> = {
    NAMESPACE: "rapidmx",
    FULLNAME: "rapidmx-server",
    DOMAIN: "example.com",
    SERVER_HOST: "mail.example.com",
    AUTH_HOST: "auth.example.com",
    AUTODISCOVER_HOST: "autodiscover.example.com",
    OPENPGPKEY_HOSTNAME: "openpgpkey.example.com",
    MAIL_DOMAINS: "example.com",
    DNS_PROVIDER: "cloudflare",
    DNS_ZONE: "",
    DNS_TAKEOVER: "false",
    DNS_CREDENTIALS_FILE: "",
    KEEP_DNS: "false",
    OPENPGPKEY_HOST: "auto",
    GATEWAY_MODE: "shared",
    // The waits are bounded by these; zero checks once.
    OPENPGPKEY_WAIT_SECONDS: "0",
    OPENPGPKEY_LOOKUP_TRIES: "3",
    DNS_CLEANUP_WAIT_SECONDS: "0",
    DNS_ROLLOUT_TIMEOUT: "30s",
    PUBLIC_IPV4_URL: "https://api.ipify.org",
    DNS_CRD_NAME: "dnsendpoints.externaldns.k8s.io",
};

/** Every variable a provider's credentials or options are read from, so a developer's own environment never leaks into a case. */
const PROVIDER_VARIABLES = [
    "CF_API_TOKEN",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_REGION",
    "EXTERNAL_DNS_AWS_ZONE_TYPE",
    "EXTERNAL_DNS_AWS_ASSUME_ROLE",
    "EXTERNAL_DNS_RFC2136_TSIG_SECRET",
    "EXTERNAL_DNS_RFC2136_HOST",
    "EXTERNAL_DNS_RFC2136_PORT",
    "EXTERNAL_DNS_RFC2136_ZONE",
    "EXTERNAL_DNS_RFC2136_TSIG_KEYNAME",
    "EXTERNAL_DNS_RFC2136_TSIG_SECRET_ALG",
    "EXTERNAL_DNS_RFC2136_INSECURE",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "EXTERNAL_DNS_GOOGLE_PROJECT",
    "AZURE_CLIENT_ID",
    "AZURE_CLIENT_SECRET",
    "AZURE_TENANT_ID",
    "AZURE_SUBSCRIPTION_ID",
    "AZURE_RESOURCE_GROUP",
];

const TOKEN = "cf-token_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const ZONE_ID = "023e105f4ecef8ad9ca31a8372d0c353";
const CLOUDFLARE_FOUND = JSON.stringify({ success: true, errors: [], result: [{ id: ZONE_ID, name: "example.com", status: "active" }], result_info: { count: 1 } });
const CLOUDFLARE_EMPTY = JSON.stringify({ success: true, errors: [], result: [], result_info: { count: 0 } });
const CLOUDFLARE_DENIED = JSON.stringify({ success: false, errors: [{ code: 9109, message: "Invalid access token" }], result: null });

/** Sources the installer's functions with the stubs and these variables, then runs `body`, without the developer's own provider environment. */
function dns(body: string, vars: Record<string, string> = {}, setup?: (work: string) => void): Run {
    // The installer's own recordInstalled and installedBy, on a state file of this run.
    return runInstaller(INSTALLER, `STATE_DIR="$WORK"; STATE_FILE="$WORK/state"\n${body}`, vars, setup, { defaults: DEFAULTS, extraStubs: ["dns-stubs.sh"], unsetEnv: PROVIDER_VARIABLES });
}

/** A work directory setup writing these files (name to content). */
function files(contents: Record<string, string>): (work: string) => void {
    return (work) => {
        for (const [name, content] of Object.entries(contents)) {
            fs.writeFileSync(path.join(work, name), content);
        }
    };
}

/** Calls that mention a verb, from the stub's log. */
function kubectlCalls(r: Run): string[] {
    return r.read("kubectl.log").split("\n").filter(Boolean);
}

/** The manifests `kubectl apply -f -` was given, in order. */
function applied(r: Run): any[] {
    return fs
        .readdirSync(r.work)
        .filter((f) => /^applied-\d+\.yaml$/.test(f))
        .sort((a, b) => parseInt(a.replace(/\D/g, ""), 10) - parseInt(b.replace(/\D/g, ""), 10))
        .map((f) => load(fs.readFileSync(path.join(r.work, f), "utf8")));
}

describe.skipIf(!bashAvailable)("single_node_install.sh: DNS publishing", () => {
    vi.setConfig({ testTimeout: 60000 });

    describe("the flags", () => {
        /** Runs the script itself: every case here must stop in the checks that follow the options, before anything is installed. */
        function script(...args: string[]): { status: number; out: string } {
            const res = spawnSync(BASH, [SCRIPT, ...args], { encoding: "utf8", env: { ...process.env, SUDO_USER: "", HOME: os.tmpdir() }, timeout: 30000 });
            return { status: res.status ?? -1, out: `${res.stdout}\n${res.stderr}` };
        }

        it("lists them in the help", () => {
            const { out } = script("--help");
            for (const flag of ["--dns-provider", "--dns-zone", "--dns-credentials-file", "--dns-takeover", "--public-address", "--keep-dns"]) {
                expect(out, flag).toContain(flag);
            }
            expect(out).toContain("CF_API_TOKEN");
        });

        it("refuses a provider type the server doesn't know", () => {
            const { status, out } = script("--domain", "example.com", "--dns-provider", "digitalocean");
            expect(status).toBe(1);
            expect(out).toContain("--dns-provider must be one of: cloudflare, route53, rfc2136, google, azure.");
        });

        it.each([
            [["--dns-takeover"], "--dns-takeover needs --dns-provider."],
            [["--dns-zone", "example.com"], "--dns-zone needs --dns-provider."],
            [["--dns-credentials-file", "/tmp/credentials"], "--dns-credentials-file needs --dns-provider."],
            [["--public-address", "8.8.8.8"], "--public-address needs --dns-provider."],
        ])("refuses %s without --dns-provider, rather than ignoring it", (args, message) => {
            const { status, out } = script("--domain", "example.com", ...args);
            expect(status).toBe(1);
            expect(out).toContain(message);
        });

        it("refuses --keep-dns without --uninstall", () => {
            const { status, out } = script("--keep-dns");
            expect(status).toBe(1);
            expect(out).toContain("--keep-dns only applies to --uninstall.");
        });

        it("refuses a --public-address the server would refuse: private, loopback, link-local and CGNAT addresses and text that isn't one", () => {
            for (const address of ["10.0.0.5", "127.0.0.1", "169.254.1.1", "100.64.0.9", "fe80::1", "example.com"]) {
                const { status, out } = script("--domain", "example.com", "--dns-provider", "cloudflare", "--public-address", address);
                expect(status, address).toBe(1);
                expect(out, address).toContain(`--public-address ${address} isn't a public (global unicast) address`);
            }
        });

        it("refuses a credentials file that can't be read, naming the file", () => {
            const { status, out } = script("--domain", "example.com", "--dns-provider", "cloudflare", "--dns-credentials-file", "/nonexistent/credentials");
            expect(status).toBe(1);
            expect(out).toContain("--dns-credentials-file (/nonexistent/credentials) isn't a readable file.");
        });

        it("takes the provider from DNS_PROVIDER and checks it the same way", () => {
            const res = spawnSync(BASH, [SCRIPT, "--domain", "example.com"], { encoding: "utf8", env: { ...process.env, DNS_PROVIDER: "bogus", SUDO_USER: "", HOME: os.tmpdir() }, timeout: 30000 });
            expect(res.status).toBe(1);
            expect(`${res.stdout}${res.stderr}`).toContain("--dns-provider must be one of");
        });
    });

    describe("isGlobalUnicast", () => {
        const check = (address: string) => dns(`isGlobalUnicast '${address}' && echo yes || echo no`).stdout.trim();

        it.each(["8.8.8.8", "203.0.113.7", "172.32.0.1", "100.128.0.1", "192.0.2.1", "2606:4700::1111", "2001:db8::1", "2a01:4f8:c17:1::2"])("accepts %s", (address) => {
            expect(check(address)).toBe("yes");
        });

        it.each([
            "0.1.2.3",
            "10.1.2.3",
            "100.64.0.1",
            "100.127.255.255",
            "127.0.0.1",
            "169.254.169.254",
            "172.16.0.1",
            "172.31.255.255",
            "192.0.0.5",
            "192.168.1.1",
            "198.18.0.1",
            "198.19.255.255",
            "224.0.0.1",
            "240.0.0.1",
            "255.255.255.255",
            "256.1.1.1",
            "1.2.3",
            "::",
            "::1",
            "::2",
            "::ffff:8.8.8.8",
            "::ffff:808:808",
            "64:ff9b:1::1",
            "fc00::1",
            "fd12:3456::1",
            "fe80::1",
            "febf::1",
            "ff02::1",
            "not-an-address",
            "",
        ])("refuses '%s', as the server does", (address) => {
            expect(check(address)).toBe("no");
        });
    });

    describe("detectPublicAddresses", () => {
        const LOCAL = [
            "1: lo    inet 127.0.0.1/8 scope host lo",
            "2: eth0    inet 203.0.113.9/24 brd 203.0.113.255 scope global eth0",
            "2: eth0    inet 10.0.0.4/24 scope global secondary eth0",
            "2: eth0    inet6 2001:db8:1::9/64 scope global dynamic mngtmpaddr eth0",
            "2: eth0    inet6 2001:db8:1::dead:beef/64 scope global temporary dynamic eth0",
            "2: eth0    inet6 2001:db8:1::cafe/64 scope global deprecated eth0",
            "3: cni0    inet 10.42.0.1/24 scope global cni0",
            "4: docker0    inet 172.17.0.1/16 scope global docker0",
        ].join("\n");
        const addresses = (r: Run) => r.stdout.split("\n").filter((l) => l.startsWith("ADDR=") && l.length > 5).map((l) => l.slice(5));
        const body = `PUBLIC_ADDRESSES=(); detectPublicAddresses; printf 'ADDR=%s\\n' "\${PUBLIC_ADDRESSES[@]}"`;

        it("takes the node's global unicast IPv4 addresses, leaving out private networks, and publishes no IPv6 address: the mail ports are IPv4-only under k3s' service load balancer", () => {
            const r = dns(body, {}, files({ "ip.out": LOCAL }));
            expect(r.status, r.stderr).toBe(0);
            expect(addresses(r)).toEqual(["203.0.113.9"]);
            // It says what it found, so the operator can override it, and that it left the IPv6 address (not the temporary or deprecated ones) alone.
            expect(r.stdout).toContain("203.0.113.9");
            expect(r.stdout).toContain("--public-address");
            expect(r.stdout).toContain("2001:db8:1::9. They are not published");
            expect(r.stdout).not.toContain("dead:beef");
            expect(r.stdout).not.toContain("cafe");
            // It had a public IPv4 address: nothing is asked of the outside world.
            expect(r.read("curl.log")).toBe("");
        });

        it("publishes an IPv6 address when it is given with --public-address", () => {
            const r = dns(`PUBLIC_ADDRESSES=(2001:db8:1::9); detectPublicAddresses; printf 'ADDR=%s\\n' "\${PUBLIC_ADDRESSES[@]}"`, {}, files({ "ip.out": LOCAL }));
            expect(addresses(r)).toEqual(["2001:db8:1::9"]);
        });

        it("asks the outside for an IPv4 address when the node has only private ones (NAT, cloud), and accepts only a public answer", () => {
            const r = dns(body, {}, files({ "ip.out": "2: eth0    inet 10.0.0.4/24 scope global eth0", "curl-v4": "198.51.100.23\n" }));
            expect(addresses(r)).toEqual(["198.51.100.23"]);
            expect(r.read("curl.log")).toContain("ipify");
            expect(r.stdout).toContain("198.51.100.23");

            const bad = dns(body, {}, files({ "ip.out": "2: eth0    inet 10.0.0.4/24 scope global eth0", "curl-v4": "10.9.9.9\n" }));
            expect(addresses(bad)).toEqual([]);
        });

        it("leaves a public IPv6 address out when only the IPv4 one is behind NAT, and uses the IPv4 one seen from outside", () => {
            const r = dns(body, {}, files({ "ip.out": ["2: eth0 inet 10.0.0.4/24 scope global eth0", "2: eth0 inet6 2001:db8:1::9/64 scope global dynamic eth0"].join("\n"), "curl-v4": "198.51.100.23" }));
            expect(addresses(r)).toEqual(["198.51.100.23"]);
            expect(r.stdout).toContain("2001:db8:1::9. They are not published");
        });

        it("goes on with no address when none can be found, saying the hosts will not be published", () => {
            const r = dns(body, {}, files({ "ip.out": "2: eth0    inet 10.0.0.4/24 scope global eth0" }));
            expect(r.status).toBe(0);
            expect(addresses(r)).toEqual([]);
            expect(r.stdout).toContain("No public IPv4 address was found");
            expect(r.stdout).toContain("--public-address");
        });

        it("uses --public-address as given and detects nothing", () => {
            const r = dns(`PUBLIC_ADDRESSES=(8.8.4.4); detectPublicAddresses; printf 'ADDR=%s\\n' "\${PUBLIC_ADDRESSES[@]}"`, {}, files({ "ip.out": LOCAL }));
            expect(addresses(r)).toEqual(["8.8.4.4"]);
            expect(r.stdout).toContain("8.8.4.4");
            expect(r.read("ip.log")).toBe("");
            expect(r.read("curl.log")).toBe("");
        });
    });

    describe("addPublicAddress", () => {
        it("keeps each address once, in the order given", () => {
            const r = dns(`PUBLIC_ADDRESSES=(); addPublicAddress 8.8.8.8; addPublicAddress 2606:4700::1111; addPublicAddress 8.8.8.8; printf 'ADDR=%s\\n' "\${PUBLIC_ADDRESSES[@]}"`);
            expect(r.stdout.split("\n").filter((l) => l.startsWith("ADDR="))).toEqual(["ADDR=8.8.8.8", "ADDR=2606:4700::1111"]);
        });
    });

    describe("jsonString", () => {
        it("quotes text for JSON, escaping quotes, backslashes and control characters", () => {
            const r = dns(`jsonString 'a "quoted" \\ back	tab'`);
            expect(JSON.parse(r.stdout)).toBe('a "quoted" \\ back\ttab');
        });
    });

    describe("loadDnsCredentials", () => {
        const provider = (r: Run) => JSON.parse(r.stdout.split("\n").filter((l) => l.startsWith("{"))[0]);

        it("reads the Cloudflare token from the environment and keeps it out of everything but the Secret", () => {
            const r = dns(`DNS_ZONE=example.com; loadDnsCredentials && dnsBootstrapSecretManifest`, { CF_API_TOKEN: TOKEN });
            expect(r.status, r.stderr + r.stdout).toBe(0);
            const secret = load(r.stdout) as any;
            expect(secret.kind).toBe("Secret");
            expect(Buffer.from(secret.data.apiToken, "base64").toString()).toBe(TOKEN);
            expect(r.stderr).not.toContain(TOKEN);
        });

        it("reads a KEY=value file: comments, blank lines, 'export', quotes and a Windows line end, and never runs it", () => {
            const file = ["# the token", "", `export CF_API_TOKEN="${TOKEN}"`, "$(touch ran-by-the-file)", ""].join("\r\n");
            const r = dns(`DNS_ZONE=example.com; DNS_CREDENTIALS_FILE="$WORK/credentials"; (loadDnsCredentials); echo "status=$?"; ls "$WORK"`, {}, files({ credentials: file }));
            // The line that is not KEY=value is refused (it names the line's number, not its text), and nothing in the file ran.
            expect(r.stdout).toContain("status=1");
            expect(r.stdout).not.toContain("ran-by-the-file");
            expect(`${r.stdout}${r.stderr}`).not.toContain(TOKEN);
            expect(`${r.stdout}${r.stderr}`).toMatch(/line 4/);

            const ok = ["# the token", "", `export CF_API_TOKEN="${TOKEN}"`, ""].join("\r\n");
            const good = dns(`DNS_ZONE=example.com; DNS_CREDENTIALS_FILE="$WORK/credentials"; loadDnsCredentials && dnsBootstrapSecretManifest`, {}, files({ credentials: ok }));
            expect(good.status, good.stderr).toBe(0);
            expect(Buffer.from((load(good.stdout) as any).data.apiToken, "base64").toString()).toBe(TOKEN);

            const single = dns(`DNS_ZONE=example.com; DNS_CREDENTIALS_FILE="$WORK/credentials"; loadDnsCredentials && dnsBootstrapSecretManifest`, {}, files({ credentials: `CF_API_TOKEN='${TOKEN}'\n` }));
            expect(Buffer.from((load(single.stdout) as any).data.apiToken, "base64").toString()).toBe(TOKEN);
        });

        it("lets the file win over the environment, which supplies what the file lacks", () => {
            const r = dns(`DNS_PROVIDER=route53; DNS_ZONE=example.com; DNS_CREDENTIALS_FILE="$WORK/credentials"; loadDnsCredentials && dnsBootstrapSecretManifest && dnsBootstrapProviderJson`, { AWS_ACCESS_KEY_ID: "AKIAFROMENVIRONMENT", AWS_SECRET_ACCESS_KEY: "from-env", AWS_REGION: "eu-west-1" }, files({ credentials: "AWS_ACCESS_KEY_ID=AKIAFROMTHEFILE\nAWS_SECRET_ACCESS_KEY=from-file\n" }));
            expect(r.status, r.stderr).toBe(0);
            const secret = load(r.stdout.split("\n{")[0]) as any;
            expect(Buffer.from(secret.data.accessKeyId, "base64").toString()).toBe("AKIAFROMTHEFILE");
            expect(Buffer.from(secret.data.secretAccessKey, "base64").toString()).toBe("from-file");
            expect(provider(r).options.region).toBe("eu-west-1");
        });

        it("refuses a name in the file that is not a setting of the provider, naming the name and never the value", () => {
            const r = dns(`DNS_ZONE=example.com; DNS_CREDENTIALS_FILE="$WORK/credentials"; loadDnsCredentials`, {}, files({ credentials: `CF_API_TOKEN=${TOKEN}\nAWS_REGION=eu-west-1\n` }));
            expect(r.status).toBe(1);
            expect(r.stdout + r.stderr).toContain("AWS_REGION isn't a setting of a cloudflare provider");
            expect(r.stdout + r.stderr).not.toContain(TOKEN);
        });

        it("says which variable is missing", () => {
            const r = dns(`DNS_ZONE=example.com; loadDnsCredentials`);
            expect(r.status).toBe(1);
            expect(r.stdout + r.stderr).toContain("CF_API_TOKEN");
            expect(r.stdout + r.stderr).toContain("--dns-credentials-file");
        });

        it("refuses a Cloudflare token that is not made of the characters a token has, since it goes into a request header", () => {
            const r = dns(`DNS_ZONE=example.com; loadDnsCredentials`, { CF_API_TOKEN: 'abc"\nX-Injected: 1' });
            expect(r.status).toBe(1);
            expect(r.stdout + r.stderr).toContain("CF_API_TOKEN");
            expect(r.stdout + r.stderr).not.toContain("X-Injected");
        });

        it("takes Route 53 with access keys, or without (the role of external-dns's ServiceAccount), but not with one of the two", () => {
            const keys = dns(`DNS_PROVIDER=route53; DNS_ZONE=example.com; loadDnsCredentials && dnsBootstrapSecretManifest && dnsBootstrapProviderJson`, { AWS_ACCESS_KEY_ID: "AKIAEXAMPLE0000000", AWS_SECRET_ACCESS_KEY: "secret", AWS_REGION: "us-east-1", EXTERNAL_DNS_AWS_ZONE_TYPE: "private" });
            expect(keys.status, keys.stderr).toBe(0);
            expect(provider(keys).options).toEqual({ region: "us-east-1", zoneType: "private" });
            expect(Object.keys((load(keys.stdout.split("\n{")[0]) as any).data).sort()).toEqual(["accessKeyId", "secretAccessKey"]);

            const irsa = dns(`DNS_PROVIDER=route53; DNS_ZONE=example.com; loadDnsCredentials && echo "[$(dnsBootstrapSecretManifest)]" && dnsBootstrapProviderJson`, { AWS_REGION: "us-east-1" });
            expect(irsa.status, irsa.stderr).toBe(0);
            // No credentials, so no Secret: the server's mount is optional.
            expect(irsa.stdout).toContain("[]");

            const half = dns(`DNS_PROVIDER=route53; DNS_ZONE=example.com; loadDnsCredentials`, { AWS_ACCESS_KEY_ID: "AKIAEXAMPLE0000000", AWS_REGION: "us-east-1" });
            expect(half.status).toBe(1);
            expect(half.stdout + half.stderr).toContain("AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY");

            const noRegion = dns(`DNS_PROVIDER=route53; DNS_ZONE=example.com; loadDnsCredentials`);
            expect(noRegion.status).toBe(1);
            expect(noRegion.stdout + noRegion.stderr).toContain("AWS_REGION");
        });

        it("takes rfc2136 with its servers as a list, the zone defaulting to the DNS zone, and requires a TSIG key unless unsigned", () => {
            const ok = dns(`DNS_PROVIDER=rfc2136; DNS_ZONE=example.com; loadDnsCredentials && dnsBootstrapSecretManifest && dnsBootstrapProviderJson`, {
                EXTERNAL_DNS_RFC2136_HOST: "ns1.example.com, 192.0.2.53",
                EXTERNAL_DNS_RFC2136_PORT: "5353",
                EXTERNAL_DNS_RFC2136_TSIG_KEYNAME: "rapidmx",
                EXTERNAL_DNS_RFC2136_TSIG_SECRET: "c2VjcmV0",
            });
            expect(ok.status, ok.stderr).toBe(0);
            expect(provider(ok).options).toEqual({ hosts: ["ns1.example.com", "192.0.2.53"], port: 5353, zone: "example.com", tsigKeyName: "rapidmx" });
            expect(Buffer.from((load(ok.stdout.split("\n{")[0]) as any).data.tsigSecret, "base64").toString()).toBe("c2VjcmV0");

            const unsigned = dns(`DNS_PROVIDER=rfc2136; DNS_ZONE=example.com; loadDnsCredentials && dnsBootstrapProviderJson`, { EXTERNAL_DNS_RFC2136_HOST: "ns1.example.com", EXTERNAL_DNS_RFC2136_INSECURE: "true" });
            expect(unsigned.status, unsigned.stderr).toBe(0);
            expect(provider(unsigned).options).toEqual({ hosts: ["ns1.example.com"], zone: "example.com", insecure: true });

            const missing = dns(`DNS_PROVIDER=rfc2136; DNS_ZONE=example.com; loadDnsCredentials`, { EXTERNAL_DNS_RFC2136_HOST: "ns1.example.com" });
            expect(missing.status).toBe(1);
            expect(missing.stdout + missing.stderr).toContain("EXTERNAL_DNS_RFC2136_TSIG_SECRET");

            const badPort = dns(`DNS_PROVIDER=rfc2136; DNS_ZONE=example.com; loadDnsCredentials`, { EXTERNAL_DNS_RFC2136_HOST: "ns1.example.com", EXTERNAL_DNS_RFC2136_INSECURE: "true", EXTERNAL_DNS_RFC2136_PORT: "dns" });
            expect(badPort.status).toBe(1);
            expect(badPort.stdout + badPort.stderr).toContain("EXTERNAL_DNS_RFC2136_PORT must be a number");

            const badFlag = dns(`DNS_PROVIDER=rfc2136; DNS_ZONE=example.com; loadDnsCredentials`, { EXTERNAL_DNS_RFC2136_HOST: "ns1.example.com", EXTERNAL_DNS_RFC2136_INSECURE: "maybe" });
            expect(badFlag.status).toBe(1);
            expect(badFlag.stdout + badFlag.stderr).toContain("EXTERNAL_DNS_RFC2136_INSECURE must be true or false");
        });

        it("reads Google's service account key from the file GOOGLE_APPLICATION_CREDENTIALS names", () => {
            const key = JSON.stringify({ type: "service_account", private_key: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n" }, null, 2);
            const r = dns(`DNS_PROVIDER=google; DNS_ZONE=example.com; GOOGLE_APPLICATION_CREDENTIALS="$WORK/key.json"; export GOOGLE_APPLICATION_CREDENTIALS; loadDnsCredentials && dnsBootstrapSecretManifest && dnsBootstrapProviderJson`, { EXTERNAL_DNS_GOOGLE_PROJECT: "my-project-123" }, files({ "key.json": key }));
            expect(r.status, r.stderr).toBe(0);
            const secret = load(r.stdout.split("\n{")[0]) as any;
            expect(Buffer.from(secret.data.serviceAccountJson, "base64").toString().trim()).toBe(key.trim());
            expect(provider(r).options).toEqual({ project: "my-project-123" });

            const missing = dns(`DNS_PROVIDER=google; DNS_ZONE=example.com; GOOGLE_APPLICATION_CREDENTIALS="$WORK/nope.json"; export GOOGLE_APPLICATION_CREDENTIALS; loadDnsCredentials`, { EXTERNAL_DNS_GOOGLE_PROJECT: "my-project-123" });
            expect(missing.status).toBe(1);
            expect(missing.stdout + missing.stderr).toContain("GOOGLE_APPLICATION_CREDENTIALS names a file that can't be read");
        });

        it("takes Azure's service principal and ids", () => {
            const GUID = "00000000-0000-4000-8000-000000000001";
            const r = dns(`DNS_PROVIDER=azure; DNS_ZONE=example.com; loadDnsCredentials && dnsBootstrapSecretManifest && dnsBootstrapProviderJson`, {
                AZURE_CLIENT_ID: GUID,
                AZURE_CLIENT_SECRET: "azure-secret",
                AZURE_TENANT_ID: GUID,
                AZURE_SUBSCRIPTION_ID: GUID,
                AZURE_RESOURCE_GROUP: "dns-rg",
            });
            expect(r.status, r.stderr).toBe(0);
            const secret = load(r.stdout.split("\n{")[0]) as any;
            expect(Object.keys(secret.data).sort()).toEqual(["clientId", "clientSecret"]);
            expect(provider(r).options).toEqual({ tenantId: GUID, subscriptionId: GUID, resourceGroup: "dns-rg" });
        });
    });

    describe("cloudflareZoneId", () => {
        it("asks Cloudflare for the zone with the token in the request's configuration on stdin, never in an argument", () => {
            const r = dns(`DNS_ZONE=example.com; loadDnsCredentials; cloudflareZoneId example.com`, { CF_API_TOKEN: TOKEN }, files({ "cloudflare.json": CLOUDFLARE_FOUND }));
            expect(r.status, r.stderr + r.stdout).toBe(0);
            expect(r.stdout.trim().split("\n").pop()).toBe(ZONE_ID);
            const calls = r.read("curl.log");
            expect(calls).toContain("https://api.cloudflare.com/client/v4/zones?name=example.com");
            expect(calls).not.toContain(TOKEN);
            expect(r.read("cloudflare-config.log")).toContain(`Authorization: Bearer ${TOKEN}`);
        });

        it("fails when Cloudflare has no such zone, and says Cloudflare's own reason when it refuses the token", () => {
            const none = dns(`DNS_ZONE=example.com; loadDnsCredentials; cloudflareZoneId example.com`, { CF_API_TOKEN: TOKEN }, files({ "cloudflare.json": CLOUDFLARE_EMPTY }));
            // 3: no such zone, which prepareDns walks past; 1 is any other failure.
            expect(none.status).toBe(3);
            expect(none.stdout).not.toMatch(/^[0-9a-f]{32}$/m);

            const denied = dns(`DNS_ZONE=example.com; loadDnsCredentials; cloudflareZoneId example.com`, { CF_API_TOKEN: TOKEN }, files({ "cloudflare.json": CLOUDFLARE_DENIED }));
            expect(denied.status).toBe(1);
            expect(denied.stdout + denied.stderr).toContain("Invalid access token");
            expect(denied.stdout + denied.stderr).not.toContain(TOKEN);

            const down = dns(`DNS_ZONE=example.com; loadDnsCredentials; cloudflareZoneId example.com`, { CF_API_TOKEN: TOKEN });
            expect(down.status).toBe(1);
            expect(down.stdout + down.stderr).toContain("Cloudflare");
        });

        it("takes an id that is not 32 hexadecimal characters for no zone at all", () => {
            const r = dns(`DNS_ZONE=example.com; loadDnsCredentials; cloudflareZoneId example.com`, { CF_API_TOKEN: TOKEN }, files({ "cloudflare.json": CLOUDFLARE_FOUND.replace(ZONE_ID, "not-a-zone-id") }));
            expect(r.status).toBe(3);
        });
    });

    describe("prepareDns", () => {
        const provider = (r: Run) => JSON.parse(r.stdout.split("\n").filter((l) => l.startsWith("PROVIDER="))[0].slice(9));

        it("with Cloudflare: the zone of the domain, its id looked up with the token, the addresses detected, and what it found printed", () => {
            const r = dns(`PUBLIC_ADDRESSES=(); prepareDns && echo "PROVIDER=$(dnsBootstrapProviderJson)"`, { CF_API_TOKEN: TOKEN }, files({ "cloudflare.json": CLOUDFLARE_FOUND, "ip.out": "2: eth0 inet 203.0.113.9/24 scope global eth0" }));
            expect(r.status, r.stderr + r.stdout).toBe(0);
            expect(provider(r)).toEqual({ name: "Cloudflare (installer)", type: "cloudflare", zones: ["example.com"], options: { zoneIds: [ZONE_ID] }, allowTakeover: false });
            expect(r.stdout).toContain("example.com");
            expect(r.stdout).toContain("203.0.113.9");
            expect(r.stdout + r.stderr).not.toContain(TOKEN);
        });

        it("walks up from a domain below its zone's apex to the zone Cloudflare has", () => {
            const r = dns(
                `DOMAIN=mail.corp.example.com; SERVER_HOST=mx.mail.corp.example.com; PUBLIC_ADDRESSES=(8.8.8.8); prepareDns && echo "PROVIDER=$(dnsBootstrapProviderJson)"`,
                { CF_API_TOKEN: TOKEN },
                files({ "cloudflare.json": CLOUDFLARE_EMPTY, "cloudflare-example.com.json": CLOUDFLARE_FOUND }),
            );
            expect(r.status, r.stderr + r.stdout).toBe(0);
            expect(provider(r).zones).toEqual(["example.com"]);
            // The most specific first, and no further than a name of two labels.
            expect(r.read("cloudflare-zones.log").split("\n").filter(Boolean)).toEqual(["mail.corp.example.com", "corp.example.com", "example.com"]);
        });

        it("asks about the zone it was told with --dns-zone alone, in lowercase and without a trailing dot", () => {
            const r = dns(`DOMAIN=mail.corp.example.com; DNS_ZONE=Example.COM.; PUBLIC_ADDRESSES=(8.8.8.8); prepareDns && echo "PROVIDER=$(dnsBootstrapProviderJson)"`, { CF_API_TOKEN: TOKEN }, files({ "cloudflare.json": CLOUDFLARE_FOUND }));
            expect(r.status, r.stderr + r.stdout).toBe(0);
            expect(provider(r).zones).toEqual(["example.com"]);
            expect(r.read("cloudflare-zones.log").split("\n").filter(Boolean)).toEqual(["example.com"]);
        });

        it("goes no further up than two labels, and stops when none has a zone", () => {
            const r = dns(`DOMAIN=mail.corp.example.com; PUBLIC_ADDRESSES=(8.8.8.8); prepareDns`, { CF_API_TOKEN: TOKEN }, files({ "cloudflare.json": CLOUDFLARE_EMPTY }));
            expect(r.status).toBe(1);
            expect(r.read("cloudflare-zones.log").split("\n").filter(Boolean)).toEqual(["mail.corp.example.com", "corp.example.com", "example.com"]);
            expect(r.stdout + r.stderr).toContain("Cloudflare has no zone");
        });

        it("refuses a zone that does not contain the domain, and a name that is not a zone", () => {
            const outside = dns(`DNS_ZONE=other.org; PUBLIC_ADDRESSES=(8.8.8.8); prepareDns`, { CF_API_TOKEN: TOKEN }, files({ "cloudflare.json": CLOUDFLARE_FOUND }));
            expect(outside.status).toBe(1);
            expect(outside.stdout + outside.stderr).toContain("--dns-zone other.org doesn't contain --domain example.com");

            const tld = dns(`DNS_ZONE=com; PUBLIC_ADDRESSES=(8.8.8.8); prepareDns`, { CF_API_TOKEN: TOKEN });
            expect(tld.status).toBe(1);
            expect(tld.stdout + tld.stderr).toContain("--dns-zone must be a domain name of at least two labels");

            const junk = dns(`DNS_ZONE='exa mple.com'; PUBLIC_ADDRESSES=(8.8.8.8); prepareDns`, { CF_API_TOKEN: TOKEN });
            expect(junk.status).toBe(1);
        });

        it("stops before any install when Cloudflare has no zone for the domain", () => {
            const r = dns(`PUBLIC_ADDRESSES=(8.8.8.8); prepareDns`, { CF_API_TOKEN: TOKEN }, files({ "cloudflare.json": CLOUDFLARE_EMPTY }));
            expect(r.status).toBe(1);
            expect(r.stdout + r.stderr).toContain("Cloudflare has no zone");
        });

        it("passes --dns-takeover on as allowTakeover", () => {
            const r = dns(`DNS_TAKEOVER=true; PUBLIC_ADDRESSES=(8.8.8.8); prepareDns && echo "PROVIDER=$(dnsBootstrapProviderJson)"`, { CF_API_TOKEN: TOKEN }, files({ "cloudflare.json": CLOUDFLARE_FOUND }));
            expect(provider(r).allowTakeover).toBe(true);
        });

        it("warns about the domains of --mail-domains the zone does not contain, which the server leaves for the administrator to publish", () => {
            const r = dns(`MAIL_DOMAINS='example.com,example.org,mail.example.com'; PUBLIC_ADDRESSES=(8.8.8.8); prepareDns`, { CF_API_TOKEN: TOKEN }, files({ "cloudflare.json": CLOUDFLARE_FOUND }));
            expect(r.status, r.stderr).toBe(0);
            expect(r.stdout).toContain("example.org");
            expect(r.stdout).toMatch(/example\.org[^\n]*(manual|by hand)/i);
            expect(r.stdout).not.toMatch(/mail\.example\.com[^\n]*(manual|by hand)/i);
        });
    });

    describe("the provider config handed to the chart", () => {
        it("escapes everything it writes into JSON", () => {
            const r = dns(`DNS_PROVIDER=route53; DNS_ZONE=example.com; loadDnsCredentials && dnsBootstrapProviderJson`, { AWS_REGION: 'us-east-1"},"injected":{"x":"', EXTERNAL_DNS_AWS_ASSUME_ROLE: "arn:aws:iam::123456789012:role/dns" });
            const parsed = JSON.parse(r.stdout.trim().split("\n").pop() as string);
            expect(Object.keys(parsed)).toEqual(["name", "type", "zones", "options", "allowTakeover"]);
            expect(parsed.options.region).toBe('us-east-1"},"injected":{"x":"');
        });

        it("renders into the chart: publishing on, the addresses, the config for the server to create and the controller's image when it is pinned", () => {
            const r = dns(`PUBLIC_ADDRESSES=(203.0.113.9 2001:db8::9); DNS_TAKEOVER=true; DNS_ZONE=example.com; loadDnsCredentials; DNS_OPTIONS[zoneIds]=${ZONE_ID}; dnsHelmValues`, { CF_API_TOKEN: TOKEN, DNS_CONTROLLER_TAG: "0.1.0" });
            expect(r.status, r.stderr + r.stdout).toBe(0);
            const values = load(r.stdout) as any;
            expect(values.dns.publishing.enabled).toBe(true);
            expect(values.dns.publicAddresses).toEqual(["203.0.113.9", "2001:db8::9"]);
            expect(values.dns.bootstrapProvider).toEqual({ name: "Cloudflare (installer)", type: "cloudflare", zones: ["example.com"], options: { zoneIds: [ZONE_ID] }, allowTakeover: true });
            expect(values.dns.controller.image.tag).toBe("0.1.0");
            // No credential in the values file's DNS part, which helm stores in the release.
            expect(r.stdout).not.toContain(TOKEN);
        });

        it("writes nothing without a provider, and leaves the controller's image to the chart unless one is given", () => {
            expect(dns(`DNS_PROVIDER=""; dnsHelmValues`).stdout.trim()).toBe("");
            const r = dns(`PUBLIC_ADDRESSES=(); DNS_ZONE=example.com; loadDnsCredentials; DNS_OPTIONS[zoneIds]=${ZONE_ID}; dnsHelmValues`, { CF_API_TOKEN: TOKEN });
            const values = load(r.stdout) as any;
            expect(values.dns.publicAddresses).toEqual([]);
            expect(values.dns.controller).toBeUndefined();
            const digest = dns(`PUBLIC_ADDRESSES=(); DNS_ZONE=example.com; loadDnsCredentials; DNS_OPTIONS[zoneIds]=${ZONE_ID}; dnsHelmValues`, { CF_API_TOKEN: TOKEN, DNS_CONTROLLER_DIGEST: "sha256:" + "a".repeat(64) });
            expect((load(digest.stdout) as any).dns.controller.image.digest).toBe("sha256:" + "a".repeat(64));
        });

        const helmAvailable = spawnSync("helm", ["version", "--short"], { stdio: "ignore" }).status === 0;
        const chart = path.join(ROOT, "helm");
        const depsAvailable = fs.existsSync(path.join(chart, "charts")) && fs.readdirSync(path.join(chart, "charts")).some((f) => f.endsWith(".tgz"));
        it.skipIf(!helmAvailable || !depsAvailable)("is accepted by the real chart: the server gets the config to create, the controller is rendered", () => {
            const r = dns(`PUBLIC_ADDRESSES=(203.0.113.9); DNS_ZONE=example.com; loadDnsCredentials; DNS_OPTIONS[zoneIds]=${ZONE_ID}; dnsHelmValues`, { CF_API_TOKEN: TOKEN, DNS_CONTROLLER_TAG: "0.1.0" });
            const valuesFile = path.join(r.work, "dns-values.yaml");
            fs.writeFileSync(valuesFile, r.stdout);
            const sets = [
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
                "mail.wkd.openpgpkeyHost.enabled=false",
            ];
            const args = ["template", "rapidmx", chart, "--namespace", "rapidmx", "-f", valuesFile];
            for (const s of sets) {
                args.push("--set", s);
            }
            const out = spawnSync("helm", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
            expect(out.status, out.stderr).toBe(0);
            const docs = (loadAll(out.stdout) as any[]).filter((d) => d && typeof d === "object");
            const config = docs.find((d) => d.kind === "ConfigMap" && d.metadata?.name === "rapidmx-server-service-config").data;
            expect(JSON.parse(config.mail__dns__bootstrap_provider)).toMatchObject({ type: "cloudflare", zones: ["example.com"], options: { zoneIds: [ZONE_ID] }, allowTakeover: false });
            expect(JSON.parse(config.mail__dns__publish__addresses)).toEqual(["203.0.113.9"]);
            expect(docs.some((d) => d.kind === "Deployment" && d.metadata?.name === "rapidmx-server-dns-controller")).toBe(true);
        });
    });

    describe("the Secret the server reads the credentials from", () => {
        const body = `DNS_ZONE=example.com; loadDnsCredentials; createDnsBootstrapSecret`;

        it("is made before the release, in a namespace made first, and is applied through stdin, never as an argument", () => {
            const r = dns(body, { CF_API_TOKEN: TOKEN });
            expect(r.status, r.stderr + r.stdout).toBe(0);
            const calls = kubectlCalls(r);
            expect(calls.join("\n")).not.toContain(TOKEN);
            expect(calls.join("\n")).not.toContain(Buffer.from(TOKEN).toString("base64"));
            // The namespace first (helm creates it only afterwards), then the Secret.
            const namespace = calls.findIndex((c) => c.includes("create namespace rapidmx --dry-run=client -o yaml"));
            expect(namespace).toBeGreaterThanOrEqual(0);
            expect(calls.lastIndexOf("apply -f -")).toBeGreaterThan(namespace + 1);
            const secret = applied(r).find((d) => d?.kind === "Secret");
            expect(secret.metadata).toEqual({ name: "rapidmx-server-dns-bootstrap", namespace: "rapidmx" });
            expect(secret.type).toBe("Opaque");
            expect(Buffer.from(secret.data.apiToken, "base64").toString()).toBe(TOKEN);
        });

        it("records when it was made, so the server's log from before is not mistaken for its answer", () => {
            const r = dns(`DNS_PROVIDER=cloudflare; loadDnsCredentials; createDnsBootstrapSecret >/dev/null; echo "at=$DNS_SECRET_APPLIED_AT"`, { CF_API_TOKEN: TOKEN });
            expect(r.stdout).toMatch(/at=\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ/);
        });

        it("is not made for a provider that needs no credentials", () => {
            const r = dns(`DNS_PROVIDER=route53; DNS_ZONE=example.com; loadDnsCredentials; createDnsBootstrapSecret`, { AWS_REGION: "us-east-1" });
            expect(r.status).toBe(0);
            expect(applied(r).find((d) => d?.kind === "Secret")).toBeUndefined();
        });

        it("holds a Google key file's lines and all", () => {
            const key = '{\n  "type": "service_account",\n  "private_key": "a\\nb"\n}\n';
            const r = dns(`DNS_PROVIDER=google; DNS_ZONE=example.com; GOOGLE_APPLICATION_CREDENTIALS="$WORK/key.json"; export GOOGLE_APPLICATION_CREDENTIALS; loadDnsCredentials; createDnsBootstrapSecret`, { EXTERNAL_DNS_GOOGLE_PROJECT: "my-project-123" }, files({ "key.json": key }));
            const secret = applied(r).find((d) => d?.kind === "Secret");
            expect(JSON.parse(Buffer.from(secret.data.serviceAccountJson, "base64").toString())).toEqual(JSON.parse(key));
        });
    });

    describe("finishDnsBootstrap", () => {
        const SECRET = { "secret-rapidmx-server-dns-bootstrap": "" };
        const deleted = (r: Run) => kubectlCalls(r).some((c) => /delete secret rapidmx-server-dns-bootstrap/.test(c));

        it("waits for the server's rollout, then deletes the Secret once the server says it created the config", () => {
            const r = dns(`finishDnsBootstrap`, {}, files({ ...SECRET, "server.log": 'info: Created the DNS provider \'Cloudflare (installer)\' (cloudflare, zones example.com) the installer configured.\n' }));
            expect(r.status, r.stderr + r.stdout).toBe(0);
            const calls = kubectlCalls(r);
            const rollout = calls.findIndex((c) => c.includes("rollout status deployment/rapidmx-server-services"));
            expect(rollout).toBeGreaterThanOrEqual(0);
            expect(calls[rollout]).toContain("--timeout=30s");
            expect(calls[rollout]).toContain("-n rapidmx");
            expect(calls.findIndex((c) => c.includes("delete secret rapidmx-server-dns-bootstrap"))).toBeGreaterThan(rollout);
            expect(r.stdout).toContain("deleted");
        });

        it("deletes it when the server found the config already there (a re-run), where the credentials are not applied again", () => {
            const r = dns(`finishDnsBootstrap`, {}, files({ ...SECRET, "server.log": "warn: The DNS provider the installer configured already exists ('Cloudflare (installer)'), so the bootstrap credentials (apiToken) are not applied to it.\n" }));
            expect(deleted(r)).toBe(true);
            expect(r.stdout).toContain("already exists");
        });

        it("keeps it, saying why, when the server could not create the config", () => {
            const r = dns(`finishDnsBootstrap`, {}, files({ ...SECRET, "server.log": "error: The DNS provider the installer configured was not created: 'apiToken' is required. The next start tries again.\n" }));
            expect(r.status).toBe(0);
            expect(deleted(r)).toBe(false);
            expect(r.stdout).toContain("'apiToken' is required");
            expect(r.stdout).toContain("kubectl -n rapidmx delete secret rapidmx-server-dns-bootstrap");
        });

        it("keeps it when nothing in the logs confirms the config, rather than deleting what it can't check", () => {
            const r = dns(`finishDnsBootstrap`, {}, files({ ...SECRET, "server.log": "info: listening on 3000\n" }));
            expect(deleted(r)).toBe(false);
            expect(r.stdout).toContain("could not be confirmed");
        });

        describe("a server that was running already (a re-run that changes nothing in the release)", () => {
            const SINCE = "DNS_SECRET_APPLIED_AT=2026-10-28T10:00:00Z";
            const OLD = 'info: Created the DNS provider \'Cloudflare (installer)\' (cloudflare, zones example.com) the installer configured.\n';
            const EXISTS = "warn: The DNS provider the installer configured already exists ('Cloudflare (installer)'), so the bootstrap credentials (apiToken) are not applied to it.\n";

            it("reads only what the server said since the Secret was made", () => {
                const r = dns(`${SINCE}; finishDnsBootstrap`, {}, files({ ...SECRET, "server.log": OLD, "server-new.log": OLD }));
                const logs = kubectlCalls(r).find((c) => / logs /.test(c))!;
                expect(logs).toContain("--since-time=2026-10-28T10:00:00Z");
            });

            it("does not take the creation its log still shows from the first install for the answer about this Secret: it restarts the server so that it reads it, then goes by what it says", () => {
                // The pods predate the Secret: since the Secret the log has nothing, until the restart.
                const r = dns(`${SINCE}; finishDnsBootstrap; echo "existed=$DNS_CONFIG_EXISTED"`, {}, files({ ...SECRET, "server.log": OLD, "server-new.log": "", "server-after-restart.log": EXISTS }));
                const calls = kubectlCalls(r);
                const restart = calls.findIndex((c) => c.includes("rollout restart deployment/rapidmx-server-services"));
                expect(restart).toBeGreaterThanOrEqual(0);
                expect(calls.slice(restart).some((c) => c.includes("rollout status deployment/rapidmx-server-services"))).toBe(true);
                expect(calls.findIndex((c) => c.includes("delete secret rapidmx-server-dns-bootstrap"))).toBeGreaterThan(restart);
                // New credentials (a rotated token) are not applied to a config that exists, and it says so rather than "stored".
                expect(r.stdout).not.toContain("stored the DNS credentials");
                expect(r.stdout).toContain("were");
                expect(r.stdout).toContain("not applied to it");
                expect(r.stdout).toContain("existed=true");
            });

            it("keeps the Secret, and does not restart again, when the restarted server still says nothing", () => {
                const r = dns(`${SINCE}; finishDnsBootstrap`, {}, files({ ...SECRET, "server.log": OLD, "server-new.log": "", "server-after-restart.log": "info: listening on 3000\n" }));
                expect(kubectlCalls(r).filter((c) => c.includes("rollout restart")).length).toBe(1);
                expect(deleted(r)).toBe(false);
                expect(r.stdout).toContain("could not be confirmed");
            });

            it("does not restart a server that has already said what it did with this Secret", () => {
                const r = dns(`${SINCE}; finishDnsBootstrap`, {}, files({ ...SECRET, "server.log": OLD, "server-new.log": OLD }));
                expect(kubectlCalls(r).some((c) => c.includes("rollout restart"))).toBe(false);
                expect(deleted(r)).toBe(true);
            });

            it("keeps the Secret when the restart does not finish", () => {
                const r = dns(`${SINCE}; finishDnsBootstrap`, { ROLLOUT_EXIT: "1" }, files({ ...SECRET, "server.log": OLD, "server-new.log": "" }));
                expect(deleted(r)).toBe(false);
            });
        });

        it("keeps it when the server does not become ready in time", () => {
            const r = dns(`finishDnsBootstrap`, { ROLLOUT_EXIT: "1" }, files({ ...SECRET, "server.log": "info: Created the DNS provider 'x'\n" }));
            expect(deleted(r)).toBe(false);
            expect(r.stdout).toContain("kubectl -n rapidmx delete secret rapidmx-server-dns-bootstrap");
        });

        it("reads the logs of the server's pods by their label, all of them", () => {
            const r = dns(`finishDnsBootstrap`, {}, files({ ...SECRET, "server.log": "Created the DNS provider 'x'\n" }));
            const logs = kubectlCalls(r).find((c) => / logs /.test(c))!;
            expect(logs).toContain("app.kubernetes.io/instance=rapidmx-server-services");
            expect(logs).toContain("--tail=-1");
        });

        it("has nothing to do for a provider that needs no Secret", () => {
            const r = dns(`finishDnsBootstrap`);
            expect(r.status).toBe(0);
            expect(kubectlCalls(r).some((c) => c.includes("delete secret"))).toBe(false);
        });
    });

    describe("the DNSEndpoint CRD", () => {
        const vendored = path.join(ROOT, "deploy/crds/dnsendpoints.externaldns.k8s.io.yaml");

        it("is vendored from external-dns v0.23.0 and is the same CRD the installer embeds", () => {
            const crd = load(fs.readFileSync(vendored, "utf8")) as any;
            expect(crd.kind).toBe("CustomResourceDefinition");
            expect(crd.metadata.name).toBe("dnsendpoints.externaldns.k8s.io");
            expect(crd.spec.scope).toBe("Namespaced");
            expect(crd.spec.versions.map((v: any) => v.name)).toEqual(["v1alpha1"]);
            const r = dns(`dnsEndpointCrd`);
            // The script is fetched on its own (curl), so it carries the CRD; this keeps the two from drifting.
            expect(r.stdout.replace(/\r\n/g, "\n")).toBe(fs.readFileSync(vendored, "utf8").replace(/\r\n/g, "\n"));
        });

        it("is applied server-side when the cluster has none, then waited for, and recorded so --uninstall removes only what the installer put there", () => {
            const r = dns(`installDnsCrd`);
            expect(r.status, r.stderr + r.stdout).toBe(0);
            const calls = kubectlCalls(r);
            expect(calls.some((c) => c.includes("apply --server-side=true -f -"))).toBe(true);
            expect(calls.some((c) => c.includes("wait --for=condition=Established crd/dnsendpoints.externaldns.k8s.io"))).toBe(true);
            expect(r.read("state")).toContain("dns_crd=true");
            expect((load(r.read("crd-applied-0.yaml")) as any).metadata.name).toBe("dnsendpoints.externaldns.k8s.io");
        });

        it("is left alone when another installation put it there", () => {
            const r = dns(`installDnsCrd`, {}, files({ crd: "" }));
            expect(r.status).toBe(0);
            expect(kubectlCalls(r).some((c) => c.includes("apply"))).toBe(false);
            expect(r.read("state")).not.toContain("dns_crd");
            expect(r.stdout).toContain("already installed");
        });

        it("is applied again when this installer put it there, so a newer vendored copy is picked up", () => {
            const r = dns(`installDnsCrd`, {}, files({ crd: "", state: "dns_crd=true\n" }));
            expect(kubectlCalls(r).some((c) => c.includes("apply --server-side=true -f -"))).toBe(true);
        });

        it("stops the install when the CRD does not become established", () => {
            const r = dns(`installDnsCrd`, { CRD_WAIT_EXIT: "1" });
            expect(r.status).toBe(1);
            expect(r.stdout + r.stderr).toContain("DNSEndpoint");
        });
    });

    describe("the openpgpkey host", () => {
        const decide = (vars: Record<string, string>, resolves: boolean, extra = "") =>
            dns(`resolvesToServer() { ${resolves ? "true" : "false"}; }; ${extra}\ndecideOpenpgpkeyHost; echo "on=$OPENPGPKEY_ON pending=$OPENPGPKEY_PENDING"`, { DNS_ZONE: "example.com", ...vars }).stdout.match(/on=\S+ pending=\S+/)![0];

        it("is never on with false", () => {
            expect(decide({ OPENPGPKEY_HOST: "false", DNS_PROVIDER: "cloudflare" }, true)).toBe("on=false pending=false");
        });

        it("is on at once when its record already resolves to the server, with or without a provider", () => {
            expect(decide({ OPENPGPKEY_HOST: "auto", DNS_PROVIDER: "cloudflare" }, true)).toBe("on=true pending=false");
            expect(decide({ OPENPGPKEY_HOST: "auto", DNS_PROVIDER: "" }, true)).toBe("on=true pending=false");
        });

        it("waits for the provider to publish the record (two steps) when it does not resolve yet and the zone is the provider's", () => {
            expect(decide({ OPENPGPKEY_HOST: "auto", DNS_PROVIDER: "cloudflare" }, false)).toBe("on=false pending=true");
            expect(decide({ OPENPGPKEY_HOST: "true", DNS_PROVIDER: "cloudflare" }, false)).toBe("on=false pending=true");
        });

        it("stays off without a provider unless forced, which is the beta.46 behaviour", () => {
            expect(decide({ OPENPGPKEY_HOST: "auto", DNS_PROVIDER: "" }, false)).toBe("on=false pending=false");
            expect(decide({ OPENPGPKEY_HOST: "true", DNS_PROVIDER: "" }, false)).toBe("on=true pending=false");
        });

        describe("an install that already exists", () => {
            const RELEASE = { release: "" };
            const SERVED = { "helm-values.json": '{"mail":{"wkd":{"openpgpkeyHost":{"enabled":true}}}}' };
            const NOT_SERVED = { "helm-values.json": '{"mail":{"wkd":{"openpgpkeyHost":{"enabled":false}}}}' };
            const CONTROLLER = { "deployment-rapidmx-server-dns-controller": "" };
            const decideIn = (world: Record<string, string>, vars: Record<string, string>, resolves: string, extra = "") =>
                dns(`resolvesToServer() { ${resolves}; }; ${extra}\ndecideOpenpgpkeyHost; echo "on=$OPENPGPKEY_ON pending=$OPENPGPKEY_PENDING assigned=$DNS_DOMAINS_ASSIGNED"`, { DNS_ZONE: "example.com", OPENPGPKEY_HOST: "auto", ...vars }, files(world));

            it("adding --dns-provider to a release that was not publishing leaves its domains manual, so nothing publishes openpgpkey.<domain> and nothing waits for it", () => {
                const r = decideIn({ ...RELEASE, ...NOT_SERVED }, {}, "false");
                expect(r.stdout).toContain("on=false pending=false assigned=false");
            });

            it("a release that was publishing, or a new one, has its domains on the provider: the record is waited for", () => {
                expect(decideIn({ ...RELEASE, ...CONTROLLER, ...NOT_SERVED }, {}, "false").stdout).toContain("on=false pending=true assigned=true");
                expect(decideIn({}, {}, "false").stdout).toContain("on=false pending=true assigned=true");
            });

            it("a release that is not upgraded with a provider has nothing to assign", () => {
                expect(decideIn({ ...RELEASE }, { DNS_PROVIDER: "" }, "false").stdout).toContain("assigned=true");
            });

            it("forces it on with true even when the domains are not on the provider", () => {
                expect(decideIn({ ...RELEASE, ...NOT_SERVED }, { OPENPGPKEY_HOST: "true" }, "false").stdout).toContain("on=true pending=false");
            });

            it("asks about the record several times before taking it for missing: one lost packet doesn't unserve the host", () => {
                const r = decideIn({ ...RELEASE, ...CONTROLLER, ...SERVED }, {}, 'n=$(( $(cat "$WORK/tries" 2>/dev/null || echo 0) + 1 )); echo $n > "$WORK/tries"; [ $n -ge 2 ]');
                expect(r.stdout).toContain("on=true pending=false");
                expect(r.read("tries").trim()).toBe("2");
                expect(r.stdout).not.toContain("stays served");
                // Without the host served, the same flap still ends in the host being served once the record answers.
                const fresh = decideIn({ ...RELEASE, ...CONTROLLER, ...NOT_SERVED }, {}, 'n=$(( $(cat "$WORK/tries" 2>/dev/null || echo 0) + 1 )); echo $n > "$WORK/tries"; [ $n -ge 3 ]');
                expect(fresh.stdout).toContain("on=true pending=false");
                expect(fresh.read("tries").trim()).toBe("3");
            });

            it("keeps serving the host the release serves when the lookup still says no after every try, instead of dropping its listeners and its certificate name", () => {
                const r = decideIn({ ...RELEASE, ...CONTROLLER, ...SERVED }, {}, "false");
                expect(r.stdout).toContain("on=true pending=false");
                expect(r.stdout).toContain("stays served");
                expect(r.stdout).toContain("--openpgpkey-host false");
            });

            it("turns it off when asked to with false, whatever the release serves", () => {
                expect(decideIn({ ...RELEASE, ...CONTROLLER, ...SERVED }, { OPENPGPKEY_HOST: "false" }, "true").stdout).toContain("on=false pending=false");
            });

            it("reads whether the release serves it, and does not take a host that was off for one that was on", () => {
                const served = (world: Record<string, string>) => dns(`openpgpkeyHostServed && echo yes || echo no`, {}, files(world)).stdout.trim();
                expect(served({ ...RELEASE, ...SERVED })).toBe("yes");
                expect(served({ ...RELEASE, ...NOT_SERVED })).toBe("no");
                expect(served({ ...RELEASE })).toBe("no");
                expect(served({ ...SERVED })).toBe("no");
            });

            it("uses the kubeconfig the install will use when KUBECONFIG is not set yet, and none when there is no helm", () => {
                const r = dns(`helm() { echo "kubeconfig=$KUBECONFIG"; }; unset KUBECONFIG; USER_KUBECONFIG="$WORK/user-kubeconfig"; clusterTool helm status x; KUBECONFIG=/own/config clusterTool helm status x; PATH=/nonexistent; unset -f helm; clusterTool helm status x && echo ran || echo "no helm"`, {}, files({ "user-kubeconfig": "" }));
                const lines = r.stdout.split("\n").filter(Boolean);
                expect(lines[0]).toMatch(/kubeconfig=.*user-kubeconfig$/);
                expect(lines[1]).toBe("kubeconfig=/own/config");
                expect(lines[2]).toBe("no helm");
            });
        });

        it("is not waited for when a provider could not publish it: a name outside its zone is forced on or stays off", () => {
            expect(decide({ OPENPGPKEY_HOST: "auto", DNS_PROVIDER: "cloudflare" }, false, "OPENPGPKEY_HOSTNAME=openpgpkey.example.org")).toBe("on=false pending=false");
            expect(decide({ OPENPGPKEY_HOST: "true", DNS_PROVIDER: "cloudflare" }, false, "OPENPGPKEY_HOSTNAME=openpgpkey.example.org")).toBe("on=true pending=false");
        });

        describe("resolvesToServer", () => {
            const resolves = (answers: Record<string, string>, extra = "") => {
                const lookups = Object.entries(answers)
                    .map(([key, value]) => `"${key}") printf '%s\\n' ${value};;`)
                    .join(" ");
                return dns(`dnsLookup() { case "$1 $2" in ${lookups} esac; }; ${extra}\nresolvesToServer openpgpkey.example.com && echo yes || echo no`).stdout.trim();
            };

            it("is true when the name's address is one of the server's public addresses", () => {
                expect(resolves({ "openpgpkey.example.com A": "203.0.113.9" }, "PUBLIC_ADDRESSES=(203.0.113.9)")).toBe("yes");
                expect(resolves({ "openpgpkey.example.com AAAA": "2001:db8::9" }, "PUBLIC_ADDRESSES=(203.0.113.9 2001:db8::9)")).toBe("yes");
            });

            it("is true when it resolves where the server's own host does, with no public address known", () => {
                expect(resolves({ "openpgpkey.example.com A": "198.51.100.4", "mail.example.com A": "198.51.100.4" }, "PUBLIC_ADDRESSES=()")).toBe("yes");
            });

            it("is false when it resolves elsewhere or not at all", () => {
                expect(resolves({ "openpgpkey.example.com A": "198.51.100.77" }, "PUBLIC_ADDRESSES=(203.0.113.9)")).toBe("no");
                expect(resolves({}, "PUBLIC_ADDRESSES=(203.0.113.9)")).toBe("no");
            });
        });

        describe("enableOpenpgpkeyHost, the second step", () => {
            const stubs = `applySharedGateway() { echo "gateway openpgpkey=$OPENPGPKEY_ON" >> "$WORK/steps.log"; }; installRelease() { echo "release openpgpkey=$OPENPGPKEY_ON" >> "$WORK/steps.log"; }`;

            it("turns the host on, in the Gateway and then the release, once the record resolves", () => {
                const r = dns(`${stubs}\nresolvesToServer() { true; }; OPENPGPKEY_ON=false; OPENPGPKEY_PENDING=true; enableOpenpgpkeyHost; echo "on=$OPENPGPKEY_ON"`);
                expect(r.status, r.stderr).toBe(0);
                expect(r.read("steps.log")).toBe("gateway openpgpkey=true\nrelease openpgpkey=true\n");
                expect(r.stdout).toContain("on=true");
            });

            it("waits for the record, up to the time it is given, polling again until it resolves", () => {
                const r = dns(`${stubs}\nn=0; resolvesToServer() { n=$((n+1)); [ $n -ge 3 ]; }; OPENPGPKEY_PENDING=true; enableOpenpgpkeyHost; echo "on=$OPENPGPKEY_ON tries=$n"`, { OPENPGPKEY_WAIT_SECONDS: "60" });
                expect(r.stdout).toContain("on=true tries=3");
            });

            it("leaves it off, with the release as it is, when the record never resolves, and says how to finish", () => {
                const r = dns(`${stubs}\nresolvesToServer() { false; }; OPENPGPKEY_ON=false; OPENPGPKEY_PENDING=true; enableOpenpgpkeyHost; echo "on=$OPENPGPKEY_ON"`);
                expect(r.status).toBe(0);
                expect(r.read("steps.log")).toBe("");
                expect(r.stdout).toContain("on=false");
                expect(r.stdout).toContain("openpgpkey.example.com");
                expect(r.stdout).toContain("re-run");
            });

            it("does nothing when the host was not pending", () => {
                const r = dns(`${stubs}\nresolvesToServer() { true; }; OPENPGPKEY_PENDING=false; enableOpenpgpkeyHost`);
                expect(r.read("steps.log")).toBe("");
            });
        });
    });

    describe("the final message", () => {
        const summary = (vars: Record<string, string> = {}, body = "") =>
            dns(`PUBLIC_ADDRESSES=(203.0.113.9); DNS_ZONE=example.com; OPENPGPKEY_ON=true; ${body}\nprintDnsSummary`, vars).stdout;

        it("says what is being published: the hosts and each domain's records", () => {
            const out = summary();
            expect(out).toContain("Cloudflare");
            expect(out).toContain("example.com");
            expect(out).toContain("mail.example.com");
            expect(out).toContain("203.0.113.9");
            expect(out).toContain("auth.example.com");
            expect(out).toContain("autodiscover.example.com");
            expect(out).toContain("openpgpkey.example.com");
            expect(out).toMatch(/MX/);
            expect(out).toMatch(/DKIM/);
            expect(out).toMatch(/DMARC/);
        });

        it("publishes the auth host as A/AAAA at the public addresses, not as a CNAME", () => {
            const out = summary();
            expect(out).toMatch(/auth\.example\.com\s+A\/AAAA 203\.0\.113\.9/);
            expect(out).not.toMatch(/auth\.example\.com\s+CNAME/);
        });

        it("says which records stay manual and why: SPF until the domain opts in, hosts and domains outside the zone", () => {
            const out = summary({}, "AUTH_HOST=auth.example.org; MAIL_DOMAINS='example.com,example.org'");
            expect(out).toMatch(/SPF[^\n]*(manual|by hand|yourself)/i);
            expect(out).toMatch(/auth\.example\.org[^\n]*(manual|by hand|yourself)/i);
            expect(out).toMatch(/example\.org[^\n]*(manual|by hand|yourself)/i);
        });

        it("says which domains are not on the provider yet when this run added it to an install that already had them, and not that their records are published", () => {
            const out = summary({}, "DNS_DOMAINS_ASSIGNED=false; OPENPGPKEY_ON=false");
            expect(out).toContain("are not on this provider yet");
            expect(out).toContain("(example.com)");
            expect(out).toContain("Assign each to the provider");
            expect(out).not.toContain("For each domain in the zone");
            // The hosts are published whatever the domains do.
            expect(out).toContain("auth.example.com");
        });

        it("says that an IPv6 address was found and left out, and how to publish it", () => {
            const out = summary({}, "UNPUBLISHED_IPV6=(2001:db8:1::9)");
            expect(out).toContain("Not published: the IPv6 address(es) 2001:db8:1::9");
            expect(out).toContain("--public-address");
            expect(summary()).not.toContain("Not published: the IPv6");
        });

        it("does not say --dns-takeover is in effect when the provider config existed: it only sets a config the server creates", () => {
            const existed = summary({ DNS_TAKEOVER: "true" }, "DNS_CONFIG_EXISTED=true");
            expect(existed).toContain("--dns-takeover was not applied");
            expect(existed).toContain("Turn on takeover in the admin console");
            expect(existed).not.toContain("are taken over");
            const created = summary({ DNS_TAKEOVER: "true" });
            expect(created).toContain("are taken over (--dns-takeover)");
            expect(created).not.toContain("was not applied");
        });

        it("says so when no address was found, since the hosts then are not published", () => {
            const out = dns(`PUBLIC_ADDRESSES=(); DNS_ZONE=example.com; OPENPGPKEY_ON=false; printDnsSummary`).stdout;
            expect(out).toContain("No public address");
            expect(out).toContain("--public-address");
        });

        it("says that rfc2136 cannot keep MX and SRV records", () => {
            const out = summary({ DNS_PROVIDER: "rfc2136" });
            expect(out).toMatch(/MX[^\n]*SRV[^\n]*(manual|by hand|yourself)/i);
        });

        it("says whether existing records are taken over, and how to see progress", () => {
            expect(summary({ DNS_TAKEOVER: "true" })).toMatch(/taken over|take over/i);
            const without = summary();
            expect(without).toMatch(/conflict/i);
            expect(without).toContain("kubectl -n rapidmx get dnsendpoints");
            expect(without).toContain("rapidmx-server-dns-controller");
            expect(without).toMatch(/admin console/i);
        });

        it("tells a Cloudflare operator to list every address the cluster goes out from if the token is restricted by address", () => {
            expect(summary()).toMatch(/IPv4 and IPv6/);
            expect(summary({ DNS_PROVIDER: "route53" })).not.toMatch(/IPv4 and IPv6/);
        });

        it("warns that a later run without the same flags turns publishing off", () => {
            expect(summary()).toMatch(/same --dns-/);
        });

        it("says, without a provider, which records to add for each host and domain", () => {
            const out = dns(`DNS_PROVIDER=""; MAIL_DOMAINS='example.com,example.net'; OPENPGPKEY_ON=false; printManualDnsRecords`).stdout;
            expect(out).toContain("mail.example.com");
            expect(out).toMatch(/MX[^\n]*mail\.example\.com/);
            expect(out).toContain("example.net");
            expect(out).toContain("v=spf1 mx ~all");
            expect(out).toMatch(/admin console/i);
        });
    });

    // The order of the script's own steps, which no function test sees.
    describe("the order of the install", () => {
        const script = fs.readFileSync(SCRIPT, "utf8").replace(/\r\n/g, "\n");
        const at = (text: string, from = 0) => {
            const index = script.indexOf(text, from);
            expect(index, text).toBeGreaterThanOrEqual(0);
            return index;
        };

        it("checks the DNS options, the credentials and the zone before it installs anything", () => {
            const prepare = at("\nprepareDns\n");
            expect(prepare).toBeLessThan(at('run_step "Updating system packages"'));
            expect(prepare).toBeGreaterThan(at('if [[ "$UNINSTALL" = "true" ]]; then\n  uninstall'));
            expect(at("\ndecideOpenpgpkeyHost\n")).toBeGreaterThan(prepare);
        });

        it("applies the CRD and makes the credentials Secret before the release, and settles the Secret, the controller and the openpgpkey host after everything is up", () => {
            const crd = at("\n  installDnsCrd\n  createDnsBootstrapSecret\n");
            const release = at("\ninstallRelease\n", crd);
            const nginx = at('run_step "Installing nginx reverse proxy"\n  configureNginx', release);
            const finish = at("\n  finishDnsBootstrap\n  waitForDnsController\n  enableOpenpgpkeyHost\n");
            expect(crd).toBeLessThan(release);
            expect(finish).toBeGreaterThan(nginx);
            expect(finish).toBeLessThan(at('echo "Installation complete."'));
        });

        it("hands the release the decision about openpgpkey.<domain>, not the option, and the DNS values", () => {
            expect(script).toContain('--set mail.wkd.openpgpkeyHost.enabled="$OPENPGPKEY_ON"');
            expect(script).not.toContain('enabled="$OPENPGPKEY_HOST"');
            expect(script).toMatch(/\n\s+dnsHelmValues\n\s+\} > "\$VALUES_FILE"/);
        });

        it("serves the Gateway's openpgpkey listeners by the same decision", () => {
            expect(script).not.toMatch(/\[\[ "\$OPENPGPKEY_HOST" = "true" \]\]/);
            expect(script).toContain('if [[ "$OPENPGPKEY_ON" = "true" ]]; then\n    OPENPGPKEY_HTTPS_LISTENER="https-openpgpkey"');
        });

        it("removes what the DNS controller published before the release, and before k3s takes the cluster with it", () => {
            const body = script.slice(script.indexOf("\nfunction uninstall() {"), script.indexOf("\nGETOPT="));
            const dnsUninstall = body.indexOf("uninstallDns");
            expect(dnsUninstall).toBeGreaterThan(0);
            expect(dnsUninstall).toBeLessThan(body.indexOf("k3s-uninstall.sh"));
            expect(dnsUninstall).toBeLessThan(body.indexOf("helm uninstall"));
            // A refusal stops the uninstall.
            expect(body).toMatch(/if ! uninstallDns "\$release" "\$KEEP_DNS"; then\n\s+exit 1/);
        });
    });

    describe("a run without --dns-provider on a release that publishes", () => {
        it("says that publishing is off now, what stays behind and how to turn it back on", () => {
            const r = dns(`DNS_PROVIDER=""; notePublishingBefore; reportPublishingTurnedOff`, {}, files({ "deployment-rapidmx-server-dns-controller": "" }));
            expect(r.stdout).toContain("publishing is off now");
            expect(r.stdout).toContain("DNSEndpoints and the records in DNS");
            expect(r.stdout).toContain("same --dns-* flags");
        });

        it("says nothing for a release that did not publish, or a run that does", () => {
            expect(dns(`DNS_PROVIDER=""; notePublishingBefore; reportPublishingTurnedOff`).stdout).toBe("");
            expect(dns(`notePublishingBefore; reportPublishingTurnedOff`, {}, files({ "deployment-rapidmx-server-dns-controller": "" })).stdout).toBe("");
        });
    });

    describe("uninstallDns", () => {
        const SELECTOR = "app.kubernetes.io/managed-by=rapidmx-dns-controller,app.kubernetes.io/instance=rapidmx";
        const ROWS = [
            "rapidmx-server-domain-example-com|example.com|example.com=MX=10 mail.example.com,;mail.example.com=A=203.0.113.9,;|example.com;_dmarc.example.com;",
            "rapidmx-server-hosts-cf||mail.example.com=A=203.0.113.9,;auth.example.com=CNAME=mail.example.com,;|",
        ].join("\n");
        // The same, without the apex TXT set: a domain that does not manage it.
        const ROWS_UNMANAGED = ROWS.replace("|example.com;_dmarc", "|_dmarc");
        /** What the zone answers for the records of ROWS while they are published. */
        const PUBLISHED = `case "$1 $2" in "mail.example.com A") echo 203.0.113.9;; "example.com MX") echo "10 mail.example.com.";; "auth.example.com CNAME") echo Mail.Example.com.;; esac`;
        const world = (extra: Record<string, string> = {}) =>
            files({ crd: "", "deployment-rapidmx-server-dns-controller": "", rows: ROWS_UNMANAGED, "all-endpoints": "dnsendpoint.externaldns.k8s.io/x\n", ...extra });
        const idx = (calls: string[], re: RegExp) => calls.findIndex((c) => re.test(c));

        it("stops, with nothing removed, while a domain's apex TXT set is managed: its values come back only through the domain's opt-out in the console", () => {
            const r = dns(`uninstallDns rapidmx false`, {}, world({ rows: ROWS }));
            expect(r.status).toBe(1);
            expect(r.stdout + r.stderr).toContain("example.com");
            expect(r.stdout + r.stderr).toMatch(/apex TXT/);
            expect(r.stdout + r.stderr).toContain("--keep-dns");
            const calls = kubectlCalls(r);
            expect(calls.some((c) => /\b(delete|scale)\b/.test(c))).toBe(false);
            // The controller is there to carry out the opt-out's restore.
            expect(r.stdout + r.stderr).not.toContain("turn publishing back on");
        });

        it("finds the managed apex set of a domain whose DNSEndpoint has no domain label (a name longer than 63 characters) by the MX or DMARC record beside it", () => {
            const long = "a".repeat(30) + "." + "b".repeat(30) + ".example.com";
            const unlabelled = (txts: string, records: string) => `rapidmx-server-domain-long||${records}|${txts}`;
            const byMx = dns(`uninstallDns rapidmx false`, {}, world({ rows: unlabelled(`${long};`, `${long}=MX=10 mail.example.com,;`) }));
            expect(byMx.status).toBe(1);
            expect(byMx.stdout).toContain(long);
            expect(kubectlCalls(byMx).some((c) => /\b(delete|scale)\b/.test(c))).toBe(false);
            const byDmarc = dns(`uninstallDns rapidmx false`, {}, world({ rows: unlabelled(`${long};_dmarc.${long};`, "") }));
            expect(byDmarc.status).toBe(1);
            // A TXT record elsewhere in a set (DKIM, DMARC) is not an apex set.
            const none = dns(`dnsLookup() { :; }; uninstallDns rapidmx false`, {}, world({ rows: unlabelled(`_dmarc.${long};default._domainkey.${long};`, `${long}=MX=10 mail.example.com,;`) }));
            expect(none.status).toBe(0);
        });

        it("says, when the DNS controller is gone, that publishing has to be turned back on before the opt-out can restore anything", () => {
            const gone = dns(`uninstallDns rapidmx false`, {}, (work) => {
                world({ rows: ROWS })(work);
                fs.rmSync(path.join(work, "deployment-rapidmx-server-dns-controller"));
            });
            expect(gone.status).toBe(1);
            expect(gone.stdout).toContain("rapidmx-server-dns-controller) isn't running");
            expect(gone.stdout).toContain("turn publishing back on first (run this script");
            expect(gone.stdout).toContain("--keep-dns");
        });

        it("does not look for a managed apex set with --keep-dns, which touches no record", () => {
            const r = dns(`uninstallDns rapidmx true`, {}, world({ rows: ROWS }));
            expect(r.status).toBe(0);
        });

        it("stops the controller first, so it can't put back what is deleted, then deletes the release's DNSEndpoints, waits for the records to go and removes the rest by label", () => {
            const r = dns(`dnsLookup() { :; }; uninstallDns rapidmx false`, {}, world());
            expect(r.status, r.stderr + r.stdout).toBe(0);
            const calls = kubectlCalls(r);
            const scale = idx(calls, /scale deployment rapidmx-server-dns-controller --replicas=0/);
            const endpoints = idx(calls, new RegExp(`delete dnsendpoints -l ${SELECTOR.replace(/[.]/g, "\\.")}`));
            const leftovers = idx(calls, new RegExp(`delete deployments,jobs,secrets -l ${SELECTOR.replace(/[.]/g, "\\.")}`));
            expect(scale).toBeGreaterThanOrEqual(0);
            expect(endpoints).toBeGreaterThan(scale);
            expect(leftovers).toBeGreaterThan(endpoints);
            expect(calls[endpoints]).toContain("-n rapidmx");
            expect(idx(calls, /delete lease rapidmx-server-dns-controller/)).toBeGreaterThan(-1);
            expect(idx(calls, /delete secret rapidmx-server-dns-bootstrap/)).toBeGreaterThan(-1);
            // The instances were left running while the records went: scaling them down is what --keep-dns does.
            expect(calls.some((c) => /scale .*external-dns.*--replicas=0/.test(c))).toBe(false);
        });

        it("checks the live DNS for the hosts' and domains' records (not the TXT sets) until they are gone", () => {
            const r = dns(`dnsLookup() { echo "$1 $2" >> "$WORK/lookups.log"; [ "$(wc -l < "$WORK/lookups.log")" -gt 6 ] || { ${PUBLISHED}; }; }; sleep() { :; }; uninstallDns rapidmx false`, { DNS_CLEANUP_WAIT_SECONDS: "600" }, world());
            expect(r.status, r.stderr + r.stdout).toBe(0);
            const lookups = r.read("lookups.log").split("\n").filter(Boolean);
            expect(lookups).toContain("mail.example.com A");
            expect(lookups).toContain("auth.example.com CNAME");
            expect(lookups).toContain("example.com MX");
            expect(lookups.some((l) => /TXT$/.test(l))).toBe(false);
            // It went on until none answered, and the leftovers were removed after that.
            expect(r.stdout).toContain("removed");
        });

        it("goes on, saying so, when a record still answers after the wait: the provider removes it on the instance's next sync", () => {
            const r = dns(`dnsLookup() { ${PUBLISHED}; }; sleep() { :; }; uninstallDns rapidmx false`, {}, world());
            expect(r.status).toBe(0);
            expect(r.stdout).toMatch(/still answer/);
            // The instances go with the next step, so nothing is left to remove them: it says so rather than promising a sync.
            expect(r.stdout).toContain("remove them at your DNS provider by hand");
            expect(r.stdout).not.toContain("on its next sync");
            expect(kubectlCalls(r).some((c) => /delete deployments,jobs,secrets/.test(c))).toBe(true);
        });

        it("does not wait for a record it never owned: one that was there before and was left alone without --dns-takeover answers with another value", () => {
            // The old MX of the domain's earlier provider, and an A record somebody else points elsewhere: both still answer after the DNSEndpoints are gone, and always will.
            const r = dns(`dnsLookup() { case "$1 $2" in "example.com MX") echo "1 aspmx.l.google.com.";; "mail.example.com A") echo 198.51.100.77;; "auth.example.com CNAME") echo other.example.net.;; esac; }; sleep() { echo slept >> "$WORK/slept.log"; }; uninstallDns rapidmx false`, { DNS_CLEANUP_WAIT_SECONDS: "600" }, world());
            expect(r.status, r.stderr + r.stdout).toBe(0);
            expect(r.stdout).toContain("have been removed");
            expect(r.stdout).not.toMatch(/still answer/);
            expect(r.read("slept.log")).toBe("");
        });

        it("compares an answer with a target without regard to case, a trailing dot or spacing", () => {
            const same = (answer: string, target: string) => dns(`dnsLookup() { printf '%s\\n' '${answer}'; }; dnsServesTarget example.com MX '${target}' && echo yes || echo no`).stdout.trim();
            expect(same("10   Mail.Example.COM.", "10 mail.example.com")).toBe("yes");
            expect(same("10 mail.example.com.", "20 mail.example.com,10 mail.example.com")).toBe("yes");
            expect(same("1 aspmx.l.google.com.", "10 mail.example.com")).toBe("no");
            expect(dns(`dnsLookup() { :; }; dnsServesTarget example.com MX '10 mail.example.com' && echo yes || echo no`).stdout.trim()).toBe("no");
        });

        it("with --keep-dns stops the instances before the DNSEndpoints go, so no record is deleted, and waits for nothing", () => {
            const r = dns(`dnsLookup() { echo "looked up" >> "$WORK/lookups.log"; }; uninstallDns rapidmx true`, {}, world());
            expect(r.status, r.stderr + r.stdout).toBe(0);
            const calls = kubectlCalls(r);
            const controller = idx(calls, /scale deployment rapidmx-server-dns-controller --replicas=0/);
            const instances = idx(calls, new RegExp(`scale deployments -l ${SELECTOR.replace(/[.]/g, "\\.")},app.kubernetes.io/name=external-dns --replicas=0`));
            const endpoints = idx(calls, /delete dnsendpoints -l/);
            expect(controller).toBeGreaterThanOrEqual(0);
            expect(instances).toBeGreaterThanOrEqual(0);
            expect(endpoints).toBeGreaterThan(instances);
            expect(r.read("lookups.log")).toBe("");
            expect(r.stdout).toMatch(/left as they are|left in DNS/);
            // The instances' credentials Secrets still go: they hold the provider's API tokens.
            expect(calls.some((c) => /delete deployments,jobs,secrets -l/.test(c))).toBe(true);
        });

        it("removes the CRD only when the installer put it there and no DNSEndpoint is left anywhere", () => {
            const ours = dns(`dnsLookup() { :; }; uninstallDns rapidmx false`, {}, world({ state: "dns_crd=true\n", "all-endpoints": "" }));
            expect(kubectlCalls(ours).some((c) => /delete crd dnsendpoints\.externaldns\.k8s\.io/.test(c))).toBe(true);

            const notOurs = dns(`dnsLookup() { :; }; uninstallDns rapidmx false`, {}, world({ "all-endpoints": "" }));
            expect(kubectlCalls(notOurs).some((c) => /delete crd/.test(c))).toBe(false);

            const inUse = dns(`dnsLookup() { :; }; uninstallDns rapidmx false`, {}, world({ state: "dns_crd=true\n", "all-endpoints": "dnsendpoint.externaldns.k8s.io/another\n" }));
            expect(kubectlCalls(inUse).some((c) => /delete crd/.test(c))).toBe(false);
            expect(inUse.stdout).toMatch(/other DNSEndpoint|still used/);
        });

        it("does nothing for an installation that never published DNS: no CRD, no controller", () => {
            const r = dns(`uninstallDns rapidmx false`, {}, files({}));
            expect(r.status).toBe(0);
            expect(kubectlCalls(r).some((c) => /\b(scale|delete dnsendpoints)\b/.test(c))).toBe(false);
        });

        it("skips it, saying so, when the cluster can't be reached", () => {
            const r = dns(`uninstallDns rapidmx false`, { KUBE_DOWN: "1" }, world());
            expect(r.status).toBe(0);
            expect(r.stdout).toMatch(/can't be reached|isn't reachable/);
            expect(kubectlCalls(r).some((c) => /\b(scale|delete)\b/.test(c))).toBe(false);
        });

        it("names a release that already has 'server' in it by itself, and any other with the chart's suffix", () => {
            const r = dns(`dnsLookup() { :; }; uninstallDns mail-server false`, {}, world({ "deployment-rapidmx-server-dns-controller": "", "deployment-mail-server-dns-controller": "" }));
            expect(kubectlCalls(r).some((c) => c.includes("scale deployment mail-server-dns-controller"))).toBe(true);
            expect(kubectlCalls(r).some((c) => c.includes("-n mail-server"))).toBe(true);
        });
    });

    // The one query the uninstall relies on that the stubs can't vouch for, run through the real kubectl against a stand-in API server.
    const kubectlAvailable = spawnSync("kubectl", ["version", "--client"], { stdio: "ignore" }).status === 0;
    describe.skipIf(!kubectlAvailable)("dnsEndpointRows, through the real kubectl", () => {
        const LIST = {
            apiVersion: "externaldns.k8s.io/v1alpha1",
            kind: "DNSEndpointList",
            items: [
                {
                    metadata: { name: "rapidmx-server-domain-example-com", labels: { "rapidmx.io/domain": "example.com" } },
                    spec: {
                        endpoints: [
                            { dnsName: "example.com", recordType: "MX", targets: ["10 mail.example.com"] },
                            { dnsName: "example.com", recordType: "TXT", targets: ['"v=spf1 mx ~all"'] },
                            { dnsName: "_dmarc.example.com", recordType: "TXT", targets: ['"v=DMARC1; p=none;"'] },
                        ],
                    },
                },
                {
                    metadata: { name: "rapidmx-server-hosts-cf", labels: { "rapidmx.io/dns-provider": "cf" } },
                    spec: { endpoints: [{ dnsName: "mail.example.com", recordType: "A", targets: ["203.0.113.9"] }] },
                },
            ],
        };

        it("lists each DNSEndpoint with its domain and its records, for the selector it was given", async () => {
            const work = fs.mkdtempSync(path.join(os.tmpdir(), "kube-api-"));
            const listFile = path.join(work, "list.json");
            const requestLog = path.join(work, "requests.log");
            fs.writeFileSync(listFile, JSON.stringify(LIST));
            fs.writeFileSync(requestLog, "");
            const api = spawn(process.execPath, [path.join(__dirname, "../fixtures/installer/fake-kube-api.cjs"), listFile, requestLog], { stdio: ["ignore", "pipe", "inherit"] });
            try {
                const port: string = await new Promise((resolve, reject) => {
                    api.stdout.once("data", (chunk) => resolve(String(chunk).trim()));
                    api.once("error", reject);
                    api.once("exit", () => reject(new Error("the stand-in API server stopped")));
                });
                const kubeconfig = path.join(work, "kubeconfig");
                fs.writeFileSync(
                    kubeconfig,
                    [
                        "apiVersion: v1",
                        "kind: Config",
                        "current-context: test",
                        "clusters: [{ name: test, cluster: { server: 'http://127.0.0.1:" + port + "' } }]",
                        "users: [{ name: test, user: {} }]",
                        "contexts: [{ name: test, context: { cluster: test, user: test } }]",
                    ].join("\n"),
                );
                const r = dns(
                    `unset -f kubectl; export KUBECONFIG='${kubeconfig.replace(/\\/g, "/")}'; dnsEndpointRows rapidmx 'app.kubernetes.io/managed-by=rapidmx-dns-controller,app.kubernetes.io/instance=rapidmx'`,
                );
                expect(r.status, r.stderr).toBe(0);
                expect(r.stdout.split("\n").filter(Boolean)).toEqual([
                    // Every record that is not TXT with its targets, then the names of the TXT ones.
                    "rapidmx-server-domain-example-com|example.com|example.com=MX=10 mail.example.com,;|example.com;_dmarc.example.com;",
                    "rapidmx-server-hosts-cf||mail.example.com=A=203.0.113.9,;|",
                ]);
                expect(decodeURIComponent(fs.readFileSync(requestLog, "utf8"))).toContain(
                    "labelSelector=app.kubernetes.io/managed-by=rapidmx-dns-controller,app.kubernetes.io/instance=rapidmx",
                );
            } finally {
                api.kill();
            }
        });
    });

    describe("waitForDnsController", () => {
        it("waits for the controller's Deployment and warns, without failing the install, if it is not ready", () => {
            const ok = dns(`waitForDnsController`);
            expect(kubectlCalls(ok).some((c) => c.includes("rollout status deployment/rapidmx-server-dns-controller"))).toBe(true);
            const bad = dns(`waitForDnsController`, { ROLLOUT_EXIT: "1" });
            expect(bad.status).toBe(0);
            expect(bad.stdout).toContain("rapidmx-server-dns-controller");
        });
    });
});
