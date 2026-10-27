///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { spawnSync } from "child_process";
import fs from "fs";
import { loadAll } from "js-yaml";
import os from "os";
import path from "path";

// Runs the OpenBao functions of both installers (single_node_install.sh and deploy/aws/bootstrap.sh) under bash, with kubectl,
// helm, openssl and the `bao` CLI in the vault's pod replaced by stubs that record what they were asked to do: the scripts sent
// into the pod are captured and then run against a fake `bao`. Both installers must behave the same, so every case runs against
// each. Skipped where there's no bash (on Windows, Git for Windows' bash is used: the one on PATH may be WSL's).
const BASH = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash";
const bashAvailable = spawnSync(BASH, ["-c", "true"]).status === 0;

const ROOT = path.resolve(__dirname, "../..");
const INSTALLERS: Record<string, string> = {
    "single_node_install.sh": path.join(ROOT, "single_node_install.sh"),
    "deploy/aws/bootstrap.sh": path.join(ROOT, "deploy/aws/bootstrap.sh"),
};

/** The text of every `function name() { ... }` in `file`, so they can be sourced without running the script. */
function functionsOf(file: string): string {
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    const out: string[] = [];
    let inside = false;
    // The terminator of the here-document being read, whose lines (a policy's closing braces, say) are text, not the function's end.
    let heredoc: string | undefined;
    for (const line of lines) {
        if (/^function [A-Za-z0-9_]+\(\) \{$/.test(line)) {
            inside = true;
        }
        if (!inside) {
            continue;
        }
        out.push(line);
        if (heredoc !== undefined) {
            if (line === heredoc) {
                heredoc = undefined;
            }
            continue;
        }
        const start = line.match(/<<\s*'?([A-Za-z_]+)'?\s*(\||\)|$|>|\s)/);
        if (start && !line.includes("<<<")) {
            heredoc = start[1];
        } else if (line === "}") {
            inside = false;
        }
    }
    return out.join("\n");
}

/** The shell stubs (stubs.sh) and the fake `bao` the captured pod scripts run against. */
const FIXTURES = path.join(__dirname, "../fixtures/installer");

interface Run {
    status: number;
    stdout: string;
    stderr: string;
    work: string;
    read(name: string): string;
    exists(name: string): boolean;
}

/** Sources the installer's functions with the stubs and these variables, then runs `body`; `setup` may add files to the work directory first. */
function run(installer: string, body: string, vars: Record<string, string> = {}, setup?: (work: string) => void): Run {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "installer-"));
    setup?.(work);
    fs.mkdirSync(path.join(work, "bin"));
    // Written with LF endings whatever the checkout has: sh takes a CR as part of the command.
    const lf = (name: string) => fs.readFileSync(path.join(FIXTURES, name), "utf8").replace(/\r\n/g, "\n");
    fs.writeFileSync(path.join(work, "bin", "bao"), lf("bao"), { mode: 0o755 });
    fs.writeFileSync(path.join(work, "stubs.sh"), lf("stubs.sh"));
    fs.writeFileSync(path.join(work, "functions.sh"), functionsOf(INSTALLERS[installer]));
    const assignments = Object.entries({
        NAMESPACE: "rapidmx",
        FULLNAME: "rapidmx-server",
        DOMAIN: "example.com",
        OPENBAO_NAMESPACE: "openbao",
        OPENBAO_POD: "openbao-0",
        OPENBAO_IMAGE: "openbao/openbao:2.6.2",
        OPENBAO_STORAGE_SIZE: "1Gi",
        STORAGE_CLASS: "gp3",
        OPENBAO_LOCAL_ADDRESS: "https://127.0.0.1:8200",
        OPENBAO_ADDRESS: "https://openbao.openbao.svc:8200",
        OPENBAO_KV_MOUNT: "secret",
        OPENBAO_PKI_MOUNT: "pki",
        OPENBAO_PKI_ROLE: "rapidmx-encryption",
        OPENBAO_SECRETS_PATH: "rapidmx-server/secrets",
        OPENBAO_ROOT_TOKEN: "s.root-token",
        OPENBAO_ESO_SECRET: "rapidmx-server-openbao-eso",
        OPENBAO_PKI_SECRET: "rapidmx-server-openbao-pki",
        OPENBAO_TLS_SECRET: "openbao-tls",
        OPENBAO_CA_SECRET: "openbao-ca",
        OPENBAO_TLS_DIR: "/openbao/userconfig/openbao-tls",
        OPENBAO_AUDIENCE: "openbao",
        OPENBAO_CA_CONFIGMAP: "rapidmx-server-openbao-ca",
        OPENBAO_ESO_SERVICE_ACCOUNT: "rapidmx-server-openbao-eso",
        OPENBAO_SERVER_ROLE: "rapidmx-server-server",
        OPENBAO_ESO_ROLE: "rapidmx-server-eso",
        OPENBAO_DNS_CONTROLLER_ROLE: "rapidmx-server-dns-controller",
        OPENBAO_INTEGRATIONS_PATH: "rapidmx-server/integrations",
        OPENBAO_INSTALL: "true",
        AUTH_SECRET: "auth-secret",
        COOKIE_SECRET: "cookie-secret",
        SESSION_SECRET: "session-secret",
        ESCROW_HMAC_KEY: "escrow-key",
        MAIL_INGEST_SECRET: "ingest-secret",
        INGEST_SECRET: "ingest-secret",
        ...vars,
    })
        .map(([key, value]) => `${key}='${value.replace(/'/g, "'\\''")}'`)
        .join("\n");
    const script = `export WORK='${work.replace(/\\/g, "/")}'\nsource "$WORK/stubs.sh"\nsource "$WORK/functions.sh"\n${assignments}\n${body}\n`;
    const res = spawnSync(BASH, ["-c", script], { encoding: "utf8", env: { ...process.env, ...vars } });
    const file = (name: string) => path.join(work, name);
    return {
        status: res.status ?? -1,
        stdout: res.stdout,
        stderr: res.stderr,
        work,
        read: (name) => (fs.existsSync(file(name)) ? fs.readFileSync(file(name), "utf8").replace(/\r\n/g, "\n") : ""),
        exists: (name) => fs.existsSync(file(name)),
    };
}

/** Runs a captured pod script against the fake `bao`, the way `sh -s` runs it in the vault's pod. */
function runInPod(r: Run, script: string, env: Record<string, string> = {}): { status: number; bao: string } {
    const work = r.work.replace(/\\/g, "/");
    // PATH by $PWD: on Windows the work directory's own name has a drive colon, which PATH would split on.
    const res = spawnSync(BASH, ["-c", `cd "${work}" && export PATH="$PWD/bin:$PATH" && sh "./${script}"`], {
        encoding: "utf8",
        env: { ...process.env, WORK: work, KUBERNETES_SERVICE_HOST: "10.43.0.1", KUBERNETES_SERVICE_PORT: "443", ...env },
    });
    return { status: res.status ?? -1, bao: r.read("bao.log") };
}

/** The policy `bao policy write <name> -` was given, from the fake bao's log. */
function policy(bao: string, name: string): string {
    const match = bao.match(new RegExp(`bao policy write ${name} -\\n<<<\\n([\\s\\S]*?)>>>`));
    return match ? match[1] : "";
}

/** The capabilities a policy grants on `path`. */
function capabilities(text: string, pathName: string): string[] {
    const match = text.match(new RegExp(`path "${pathName.replace(/[*]/g, "\\*")}" \\{\\s*capabilities = \\[([^\\]]*)\\]`));
    return match ? match[1].split(",").map((c) => c.trim().replace(/"/g, "")) : [];
}

const b64 = (value: string) => Buffer.from(value).toString("base64");

describe.skipIf(!bashAvailable)("installers: OpenBao with Kubernetes auth and TLS", () => {
    vi.setConfig({ testTimeout: 60000 });

    for (const installer of Object.keys(INSTALLERS)) {
        describe(installer, () => {
            describe("prepareOpenbao", () => {
                it("enables Kubernetes auth and creates a role per client, each bound to one ServiceAccount, the audience and a one-hour token", () => {
                    const r = run(installer, "prepareOpenbao");
                    expect(r.status, r.stderr + r.stdout).toBe(0);
                    // Everything secret goes over stdin, never in an argument.
                    expect(r.read("kubectl.log")).not.toContain("s.root-token");
                    const script = r.read("pod-script-0.sh");
                    expect(script).toContain("s.root-token");

                    const { status, bao } = runInPod(r, "pod-script-0.sh", { BAO_SECRETS: "{}", BAO_AUTHS: '{"token/":{}}' });
                    expect(status).toBe(0);
                    expect(bao).toContain("bao auth enable kubernetes");
                    expect(bao).toContain("bao write auth/kubernetes/config kubernetes_host=https://10.43.0.1:443");

                    const role = (name: string) => bao.split("\n").find((line) => line.startsWith(`bao write auth/kubernetes/role/${name} `)) ?? "";
                    const expectRole = (name: string, account: string, policyName: string) => {
                        const line = role(name);
                        expect(line, name).toContain(`bound_service_account_names=${account} `);
                        expect(line, name).toContain("bound_service_account_namespaces=rapidmx ");
                        expect(line, name).toContain("audience=openbao ");
                        expect(line, name).toContain(`token_policies=${policyName} `);
                        expect(line, name).toContain("token_ttl=1h");
                        expect(line, name).toContain("token_max_ttl=1h");
                    };
                    expectRole("rapidmx-server-server", "rapidmx-server", "rapidmx-server-server");
                    expectRole("rapidmx-server-eso", "rapidmx-server-openbao-eso", "rapidmx-server-eso");
                    expectRole("rapidmx-server-dns-controller", "rapidmx-server-dns-controller", "rapidmx-server-dns-controller");
                });

                it("creates no long-lived token any more", () => {
                    const r = run(installer, "prepareOpenbao");
                    const script = r.read("pod-script-0.sh");
                    expect(script).not.toMatch(/token create/);
                    expect(script).not.toMatch(/-period=/);
                    expect(script).not.toMatch(/auth tune/);
                    // No Secret is written for one.
                    expect(r.read("kubectl.log")).not.toMatch(/create secret generic rapidmx-server-openbao-(eso|pki)/);
                });

                it("lets the server write DNS credentials but never read them, and read its own and the plugins' secrets", () => {
                    const r = run(installer, "prepareOpenbao");
                    const { bao } = runInPod(r, "pod-script-0.sh", { BAO_SECRETS: '{"secret/":{},"pki/":{}}', BAO_AUTHS: '{"kubernetes/":{}}' });
                    const server = policy(bao, "rapidmx-server-server");
                    const base = "secret/data/rapidmx-server/integrations";
                    expect(capabilities(server, `${base}/dns/*`).sort()).toEqual(["create", "delete", "patch", "update"]);
                    expect(capabilities(server, "secret/metadata/rapidmx-server/integrations/dns/*").sort()).toEqual(["delete", "read"]);
                    for (const consumer of ["server", "plugins"]) {
                        expect(capabilities(server, `${base}/${consumer}/*`).sort(), consumer).toEqual(["create", "delete", "patch", "read", "update"]);
                        expect(capabilities(server, `secret/metadata/rapidmx-server/integrations/${consumer}/*`).sort(), consumer).toEqual(["delete", "read"]);
                    }
                    expect(capabilities(server, "pki/sign/rapidmx-encryption")).toEqual(["update"]);
                    expect(capabilities(server, "pki/revoke")).toEqual(["update"]);
                    // Nothing else: not the release's own secrets, which only External Secrets reads.
                    expect(server).not.toContain("rapidmx-server/secrets");

                    const eso = policy(bao, "rapidmx-server-eso");
                    expect(capabilities(eso, "secret/data/rapidmx-server/secrets")).toEqual(["read"]);
                    expect(capabilities(eso, "secret/metadata/rapidmx-server/secrets")).toEqual(["read"]);
                    expect(capabilities(eso, `${base}/dns/*`)).toEqual(["read"]);
                    expect(eso).not.toContain("integrations/server");
                    expect(eso).not.toContain("pki/");

                    const controller = policy(bao, "rapidmx-server-dns-controller");
                    expect(capabilities(controller, "secret/metadata/rapidmx-server/integrations/dns/*")).toEqual(["read"]);
                    expect(controller).not.toContain("secret/data/");
                    expect(controller.match(/path "/g)).toHaveLength(1);

                    // Already enabled: not enabled again.
                    expect(bao).not.toContain("bao auth enable kubernetes");
                    expect(bao).not.toContain("bao secrets enable");
                });

                it("keeps seeding the release's secrets and the PKI mount as before", () => {
                    const r = run(installer, "prepareOpenbao");
                    const { bao } = runInPod(r, "pod-script-0.sh", { BAO_SECRETS: "{}", BAO_AUTHS: "{}" });
                    expect(bao).toContain("bao secrets enable -path=secret -version=2 kv");
                    expect(bao).toContain("bao secrets enable -path=pki -max-lease-ttl=87600h pki");
                    expect(bao).toMatch(/bao kv (put|patch) -mount=secret rapidmx-server\/secrets auth_secret=auth-secret/);
                    expect(bao).toContain("bao write pki/roles/rapidmx-encryption");
                });

                it("fails when the vault refuses the preparation", () => {
                    const r = run(installer, "prepareOpenbao", { POD_EXIT: "1" });
                    expect(r.status).not.toBe(0);
                });
            });

            describe("migrateOpenbaoTokens", () => {
                const withTokens = (work: string) => {
                    fs.writeFileSync(path.join(work, "secret-rapidmx-server-openbao-eso"), b64("hvs.eso-token"));
                    fs.writeFileSync(path.join(work, "secret-rapidmx-server-openbao-pki"), b64("hvs.pki-token"));
                };
                const migrate = (vars: Record<string, string> = {}, tokens = true) => run(installer, "migrateOpenbaoTokens", vars, tokens ? withTokens : undefined);

                it("revokes both old tokens through stdin once every SecretStore is Ready, then deletes their Secrets and policies", () => {
                    const r = migrate();
                    expect(r.status, r.stderr + r.stdout).toBe(0);
                    const kubectl = r.read("kubectl.log");
                    expect(kubectl).not.toContain("hvs.eso-token");
                    expect(kubectl).not.toContain("hvs.pki-token");
                    const lines = kubectl.split("\n");
                    const waited = lines.findIndex((l) => l.includes("wait --for=condition=Ready secretstore"));
                    const exec = lines.findIndex((l) => l.includes("exec -i openbao-0"));
                    const deleted = lines.findIndex((l) => l.includes("delete secret"));
                    expect(waited).toBeGreaterThanOrEqual(0);
                    expect(exec).toBeGreaterThan(waited);
                    expect(deleted).toBeGreaterThan(exec);
                    expect(lines[deleted]).toContain("rapidmx-server-openbao-eso");
                    expect(lines[deleted]).toContain("rapidmx-server-openbao-pki");

                    const { status, bao } = runInPod(r, "pod-script-0.sh");
                    expect(status).toBe(0);
                    expect(bao).toContain('bao write auth/token/revoke -\n<<<\n{"token":"hvs.eso-token"}');
                    expect(bao).toContain('{"token":"hvs.pki-token"}');
                    expect(bao).toContain("bao policy delete rapidmx-server-secrets-read");
                    expect(bao).toContain("bao policy delete rapidmx-server-pki");
                    // The token values are never a command's argument in the pod either.
                    expect(bao.split("\n").filter((l) => l.startsWith("bao ")).join("\n")).not.toContain("hvs.");
                });

                it("first proves that External Secrets' and the server's ServiceAccounts can log in to their new roles", () => {
                    const r = migrate();
                    const kubectl = r.read("kubectl.log");
                    // Short-lived tokens for the roles' audience, requested here and passed to the pod over stdin only.
                    expect(kubectl).toContain("-n rapidmx create token rapidmx-server-openbao-eso --audience openbao --duration 10m");
                    expect(kubectl).toContain("-n rapidmx create token rapidmx-server --audience openbao --duration 10m");
                    expect(kubectl).not.toContain("eyJ");
                    expect(r.read("pod-script-0.sh")).toContain("eyJ.rapidmx-server-openbao-eso.sig");

                    const { bao } = runInPod(r, "pod-script-0.sh");
                    const esoLogin = bao.indexOf('{"role":"rapidmx-server-eso","jwt":"eyJ.rapidmx-server-openbao-eso.sig"}');
                    const serverLogin = bao.indexOf('{"role":"rapidmx-server-server","jwt":"eyJ.rapidmx-server.sig"}');
                    const firstRevoke = bao.indexOf('{"token":"hvs.');
                    expect(esoLogin).toBeGreaterThan(0);
                    expect(serverLogin).toBeGreaterThan(0);
                    expect(firstRevoke).toBeGreaterThan(Math.max(esoLogin, serverLogin));
                    // The OpenBao tokens those logins got are revoked at once.
                    expect(bao).toContain('{"token":"s.login-token"}');
                    expect(bao.split("\n").filter((l) => l.startsWith("bao ")).join("\n")).not.toContain("eyJ");
                });

                it("keeps the old tokens when no ServiceAccount token can be had to prove the new roles with", () => {
                    const r = migrate({ CREATE_TOKEN_EXIT: "1" });
                    expect(r.status).toBe(0);
                    expect(r.exists("pod-script-0.sh")).toBe(false);
                    expect(r.read("kubectl.log")).not.toContain("delete secret");
                });

                it("revokes nothing while a SecretStore isn't Ready, so a re-run finishes the move", () => {
                    const r = migrate({ STORES_READY: "1" });
                    expect(r.status).toBe(0);
                    expect(r.exists("pod-script-0.sh")).toBe(false);
                    expect(r.read("kubectl.log")).not.toContain("delete secret");
                    expect(r.stdout).toMatch(/SecretStore/);
                });

                it("keeps the Secrets when the vault can't revoke", () => {
                    const r = migrate({ POD_EXIT: "1" });
                    expect(r.read("kubectl.log")).not.toContain("delete secret");
                });

                it("does nothing on an install that never had the tokens", () => {
                    const r = migrate({}, false);
                    expect(r.status).toBe(0);
                    expect(r.read("kubectl.log")).not.toContain("wait --for");
                    expect(r.exists("pod-script-0.sh")).toBe(false);
                });

                it("never puts a token that isn't one into the script", () => {
                    const r = run(installer, "migrateOpenbaoTokens", {}, (work) => fs.writeFileSync(path.join(work, "secret-rapidmx-server-openbao-eso"), b64("x'; rm -rf / #")));
                    expect(r.read("pod-script-0.sh")).not.toContain("rm -rf");
                });
            });

            describe("the listener certificate", () => {
                it("is issued by a CA of its own in OpenBao's namespace for every name the vault is reached at, for a year, renewed a month ahead", () => {
                    const r = run(installer, "openbaoTlsManifest > \"$WORK/tls.yaml\"");
                    expect(r.status, r.stderr).toBe(0);
                    const docs = loadAll(r.read("tls.yaml")) as any[];
                    const byName = (kind: string, name: string) => docs.find((d) => d?.kind === kind && d.metadata?.name === name);
                    expect(docs.every((d) => d.metadata.namespace === "openbao")).toBe(true);
                    expect(byName("Issuer", "openbao-selfsigned").spec).toEqual({ selfSigned: {} });
                    const ca = byName("Certificate", "openbao-ca").spec;
                    expect(ca).toMatchObject({ isCA: true, secretName: "openbao-ca", issuerRef: { name: "openbao-selfsigned", kind: "Issuer" } });
                    expect(byName("Issuer", "openbao-ca").spec).toEqual({ ca: { secretName: "openbao-ca" } });
                    const leaf = byName("Certificate", "openbao-tls").spec;
                    expect(leaf).toMatchObject({ secretName: "openbao-tls", duration: "8760h", renewBefore: "720h", issuerRef: { name: "openbao-ca", kind: "Issuer" } });
                    expect(leaf.dnsNames).toEqual(
                        expect.arrayContaining([
                            "openbao",
                            "openbao.openbao",
                            "openbao.openbao.svc",
                            "openbao.openbao.svc.cluster.local",
                            "openbao-0.openbao-internal",
                            "openbao-0.openbao-internal.openbao.svc.cluster.local",
                        ])
                    );
                    // The `bao` CLI in the pod talks to https://127.0.0.1:8200.
                    expect(leaf.ipAddresses).toContain("127.0.0.1");
                });

                it("is served by OpenBao's TLS listener, with a sidecar that reloads it, hardened, sharing the pod's process namespace", () => {
                    const r = run(installer, "openbaoHelmValues > \"$WORK/values.yaml\"");
                    expect(r.status, r.stderr).toBe(0);
                    const values = loadAll(r.read("values.yaml"))[0] as any;
                    expect(values.global.tlsDisable).toBe(false);
                    expect(values.injector.enabled).toBe(false);
                    const config: string = values.server.standalone.config;
                    expect(config).toContain('tls_cert_file = "/openbao/userconfig/openbao-tls/tls.crt"');
                    expect(config).toContain('tls_key_file = "/openbao/userconfig/openbao-tls/tls.key"');
                    expect(config).not.toMatch(/tls_disable\s*=\s*(1|true)/);
                    expect(values.server.extraVolumes).toEqual([{ type: "secret", name: "openbao-tls" }]);
                    expect(values.server.extraEnvironmentVars.BAO_CACERT).toBe("/openbao/userconfig/openbao-tls/ca.crt");
                    expect(values.server.shareProcessNamespace).toBe(true);
                    expect(values.server.dataStorage).toMatchObject({ enabled: true, size: "1Gi" });

                    expect(values.server.extraContainers).toHaveLength(1);
                    const sidecar = values.server.extraContainers[0];
                    // The image the vault already runs: nothing new to pull or trust.
                    expect(sidecar.image).toBe("openbao/openbao:2.6.2");
                    expect(sidecar.securityContext).toEqual({
                        runAsNonRoot: true,
                        runAsUser: 100,
                        runAsGroup: 1000,
                        readOnlyRootFilesystem: true,
                        allowPrivilegeEscalation: false,
                        capabilities: { drop: ["ALL"] },
                    });
                    expect(sidecar.volumeMounts).toEqual([{ name: "userconfig-openbao-tls", mountPath: "/openbao/userconfig/openbao-tls", readOnly: true }]);
                    // The chart passes extraContainers through `tpl`: the script must not contain template braces.
                    expect(JSON.stringify(sidecar)).not.toContain("{{");
                });

                it("is reloaded with SIGHUP to `bao server` alone, once per change of the certificate or key", () => {
                    const r = run(installer, "openbaoReloadScript > \"$WORK/reload.sh\"");
                    const work = r.work.replace(/\\/g, "/");
                    fs.mkdirSync(path.join(r.work, "tls"));
                    fs.writeFileSync(path.join(r.work, "tls", "tls.crt"), "cert-1");
                    fs.writeFileSync(path.join(r.work, "tls", "tls.key"), "key-1");
                    const proc = path.join(r.work, "proc");
                    // 100 is the sidecar itself, `sh -c <the script>`, whose command line has "bao server" in it; it lists before 7.
                    const sidecar = `/bin/sh\0-c\0${r.read("reload.sh")}\0`;
                    const processes = {
                        "1": "/pause\0",
                        "7": "bao\0server\0-config=/tmp/storageconfig.hcl\0",
                        "9": "/bin/sh\0-c\0bao server\0",
                        "12": "bao\0status\0",
                        "15": "/usr/local/bin/bao\0server\0",
                        "100": sidecar,
                    };
                    for (const [pid, cmdline] of Object.entries(processes)) {
                        fs.mkdirSync(path.join(proc, pid), { recursive: true });
                        fs.writeFileSync(path.join(proc, pid, "cmdline"), cmdline);
                    }
                    // A fake clock: the files change after the 2nd sleep (cert-manager renews), stay the same for two more, then it stops.
                    // A process listed under the shell's own PID looks like `bao server` too, and must still be skipped. Each `kill`
                    // also sends the shell a real SIGHUP, which it must ignore to get to the end.
                    const harness = String.raw`
                        calls=0
                        sleep() {
                          calls=$((calls + 1))
                          [ $calls -eq 2 ] && printf 'cert-2' > "$WORK/tls/tls.crt"
                          [ $calls -eq 5 ] && return 1
                          return 0
                        }
                        kill() { echo "kill $*" >> "$WORK/kill.log"; command kill -HUP $$; }
                        mkdir -p "$WORK/proc/$$" && printf 'bao\0server\0' > "$WORK/proc/$$/cmdline"
                        export TLS_DIR="$WORK/tls" PROC_DIR="$WORK/proc" INTERVAL=30
                        source "$WORK/reload.sh"
                    `;
                    const res = spawnSync(BASH, ["-c", harness], { encoding: "utf8", env: { ...process.env, WORK: work } });
                    expect(res.status, res.stderr).toBe(0);
                    expect(fs.readFileSync(path.join(r.work, "kill.log"), "utf8").trim().split(/\r?\n/)).toEqual(["kill -HUP 15", "kill -HUP 7"]);
                });

                it("is checked after an upgrade: the certificate OpenBao serves must be the one in its Secret", () => {
                    const stored = (work: string) => fs.writeFileSync(path.join(work, "secret-openbao-tls"), b64("Oct 27 2027 GMT"));
                    const ok = run(installer, "checkOpenbaoCertificate", { SERVED_CERT: "Oct 27 2027 GMT" }, stored);
                    expect(ok.status).toBe(0);
                    expect(ok.stdout).not.toMatch(/delete pod/i);

                    const stale = run(installer, "checkOpenbaoCertificate", { SERVED_CERT: "Oct 27 2026 GMT" }, stored);
                    expect(stale.status).toBe(0);
                    expect(stale.stdout + stale.stderr).toContain("Oct 27 2026");
                    expect(stale.stdout + stale.stderr).toContain("delete pod openbao-0");
                });
            });

            describe("the unsealer and the pod's restart", () => {
                it("unseals over TLS, trusting only the listener's CA from its Secret", () => {
                    const r = run(installer, "openbaoUnsealerManifest > \"$WORK/unsealer.yaml\"");
                    const deployment = loadAll(r.read("unsealer.yaml"))[0] as any;
                    const container = deployment.spec.template.spec.containers[0];
                    const env = Object.fromEntries(container.env.filter((e: any) => e.value).map((e: any) => [e.name, e.value]));
                    expect(env.BAO_ADDR).toBe("https://openbao.openbao.svc:8200");
                    expect(env.BAO_CACERT).toBe("/etc/openbao-ca/ca.crt");
                    expect(container.volumeMounts).toEqual([{ name: "openbao-ca", mountPath: "/etc/openbao-ca", readOnly: true }]);
                    // Only the certificate of the CA: the listener's private key in the same Secret is not mounted.
                    expect(deployment.spec.template.spec.volumes).toEqual([
                        { name: "openbao-ca", secret: { secretName: "openbao-tls", items: [{ key: "ca.crt", path: "ca.crt" }] } },
                    ]);
                    expect(deployment.spec.template.spec.automountServiceAccountToken).toBe(false);
                });

                it("restarts the vault's pod only when it runs an older revision than the StatefulSet's (its update strategy is OnDelete)", () => {
                    const changed = run(installer, "restartOpenbaoIfChanged", { UPDATE_REVISION: "openbao-2", POD_REVISION: "openbao-1" });
                    expect(changed.status, changed.stderr).toBe(0);
                    expect(changed.read("kubectl.log")).toContain("delete pod openbao-0");
                    const same = run(installer, "restartOpenbaoIfChanged", { UPDATE_REVISION: "openbao-2", POD_REVISION: "openbao-2" });
                    expect(same.read("kubectl.log")).not.toContain("delete pod");
                });
            });

            describe("the address of a vault this script doesn't install", () => {
                it("must be https unless it is this host", () => {
                    const check = (address: string) => run(installer, `openbaoAddressAllowed '${address}'`).status;
                    expect(check("https://vault.example.com:8200")).toBe(0);
                    expect(check("http://127.0.0.1:8200")).toBe(0);
                    expect(check("http://localhost:8200")).toBe(0);
                    expect(check("http://[::1]:8200")).toBe(0);
                    expect(check("http://openbao.openbao.svc:8200")).not.toBe(0);
                    expect(check("http://127.0.0.1.attacker.example:8200")).not.toBe(0);
                });
            });
        });
    }
});

