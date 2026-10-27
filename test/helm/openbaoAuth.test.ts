///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { spawnSync } from "child_process";
import fs from "fs";
import { loadAll } from "js-yaml";
import path from "path";

// Renders the real chart with `helm template` to check how the release reaches OpenBao: External Secrets with a token Secret (a
// vault prepared by hand) or with Kubernetes auth as a ServiceAccount of its own, verifying OpenBao's listener with the CA the
// installer copies into the namespace; and the server's own identity, a projected ServiceAccount token for the audience "openbao"
// that its PKI and secret-store clients log in with. Skipped where `helm` isn't installed or the chart's dependencies haven't
// been fetched (`helm dependency update ./helm`).
const CHART = path.resolve(__dirname, "../../helm");
const helmAvailable = spawnSync("helm", ["version", "--short"], { stdio: "ignore" }).status === 0;
const depsAvailable = fs.existsSync(path.join(CHART, "charts")) && fs.readdirSync(path.join(CHART, "charts")).some((f) => f.endsWith(".tgz"));

const BASE = [
    "global.domain=example.com",
    "host=mail.example.com",
    "global.mailIngestSecret=" + "a".repeat(32),
    "global.jwt.secret=y",
    "global.secrets.cookies=c",
    "global.secrets.sessions=s",
    "mail.escrow.auditHmacKey=k",
    "mail.rspamd.controller.password=abcdefghijklmnop1",
    "coturn.auth.sharedSecret=abc123",
    "authserver.service.config.auth__oauth_server__keys__encryption_key=" + "0123456789abcdef".repeat(4),
    "authserver.service.config.auth__totp__encryption_key=" + "fedcba9876543210".repeat(4),
    "global.openbao.enabled=true",
    "global.openbao.address=https://openbao.openbao.svc:8200",
];

// What single_node_install.sh and deploy/aws/bootstrap.sh pass for the OpenBao they install (release "rapidmx", so the chart's
// fullname is "rapidmx-server").
const INSTALLER = [
    "global.openbao.caConfigMap=rapidmx-server-openbao-ca",
    "global.openbao.auth.method=kubernetes",
    "global.openbao.auth.kubernetes.role=rapidmx-server-eso",
    "global.openbao.auth.kubernetes.serviceAccount=rapidmx-server-openbao-eso",
    "global.openbao.auth.kubernetes.audience=openbao",
    "openbao.auth.method=kubernetes",
];

interface Doc {
    kind?: string;
    metadata?: { name?: string };
    spec?: any;
    data?: Record<string, string>;
    automountServiceAccountToken?: boolean;
}

function render(...sets: string[]): Doc[] {
    // The External Secrets CRDs a real cluster would have (the chart refuses to render its ExternalSecrets without them).
    const args = ["template", "rapidmx", CHART, "--namespace", "rapidmx", "--api-versions", "external-secrets.io/v1"];
    for (const s of [...BASE, ...sets]) {
        args.push("--set", s);
    }
    const res = spawnSync("helm", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (res.status !== 0) {
        throw new Error(res.stderr);
    }
    return (loadAll(res.stdout) as Doc[]).filter((d) => d && typeof d === "object");
}

const find = (all: Doc[], kind: string, name: string) => all.find((d) => d.kind === kind && d.metadata?.name === name);
const serverStore = (all: Doc[]) => find(all, "SecretStore", "rapidmx-server-openbao")!.spec.provider.vault;
const serverPod = (all: Doc[]) => find(all, "Deployment", "rapidmx-server-services")!.spec.template.spec;
const serverConfig = (all: Doc[]) => find(all, "ConfigMap", "rapidmx-server-service-config")!.data!;

describe.skipIf(!helmAvailable || !depsAvailable)("chart: OpenBao authentication and TLS", () => {
    vi.setConfig({ testTimeout: 60000 });

    it("renders with the vault on and nothing else set, loading no PKI token Secret", () => {
        const all = render();
        const container = serverPod(all).containers[0];
        expect(JSON.stringify(container.envFrom)).not.toContain("openbao");
        expect(serverConfig(all).mail__pki__openbao__token).toBeUndefined();
    });

    it("keeps a token Secret for External Secrets by default, without a CA or a server identity", () => {
        const all = render();
        const store = serverStore(all);
        expect(store.server).toBe("https://openbao.openbao.svc:8200");
        expect(store.auth).toEqual({ tokenSecretRef: { name: "rapidmx-server-openbao-eso", key: "token" } });
        expect(store.caProvider).toBeUndefined();
        expect(all.filter((d) => d.kind === "ServiceAccount").map((d) => d.metadata?.name)).not.toContain("rapidmx-server-openbao-eso");

        const pod = serverPod(all);
        expect(JSON.stringify(pod.volumes)).not.toContain("serviceAccountToken");
        expect(serverConfig(all).mail__pki__openbao__auth__method).toBeUndefined();
        expect(serverConfig(all).mail__secrets__openbao__auth__method).toBeUndefined();
    });

    it("logs External Secrets in with Kubernetes auth as its own ServiceAccount, for the audience the role checks, over TLS with the copied CA", () => {
        const all = render(...INSTALLER);
        const store = serverStore(all);
        expect(store.caProvider).toEqual({ type: "ConfigMap", name: "rapidmx-server-openbao-ca", key: "ca.crt" });
        expect(store.auth).toEqual({
            kubernetes: {
                mountPath: "kubernetes",
                role: "rapidmx-server-eso",
                serviceAccountRef: { name: "rapidmx-server-openbao-eso", audiences: ["openbao"] },
            },
        });

        // External Secrets requests that ServiceAccount's tokens itself: no pod runs as it, and it mounts no token anywhere.
        const account = find(all, "ServiceAccount", "rapidmx-server-openbao-eso");
        expect(account).toBeDefined();
        expect(account!.automountServiceAccountToken).toBe(false);
        // Not the server's own ServiceAccount, whose OpenBao role may write credentials External Secrets reads.
        expect(serverPod(all).serviceAccountName).toBe("rapidmx-server");
    });

    it("leaves out the audience when none is set, and the ServiceAccount when it is the namespace's default or created elsewhere", () => {
        const noAudience = render(
            "global.openbao.auth.method=kubernetes",
            "global.openbao.auth.kubernetes.role=r",
            "global.openbao.auth.kubernetes.serviceAccount=default"
        );
        expect(serverStore(noAudience).auth.kubernetes.serviceAccountRef).toEqual({ name: "default" });
        expect(noAudience.filter((d) => d.kind === "ServiceAccount").map((d) => d.metadata?.name)).not.toContain("default");

        const existing = render(...INSTALLER, "openbao.externalSecrets.createServiceAccount=false");
        expect(find(existing, "ServiceAccount", "rapidmx-server-openbao-eso")).toBeUndefined();
    });

    it("gives the server a projected ServiceAccount token for OpenBao and the CA, and tells both of its clients how to log in", () => {
        const all = render(...INSTALLER);
        const pod = serverPod(all);
        const tokenVolume = pod.volumes.find((v: any) => v.name === "openbao-token");
        expect(tokenVolume).toEqual({
            name: "openbao-token",
            projected: { sources: [{ serviceAccountToken: { audience: "openbao", expirationSeconds: 3600, path: "token" } }] },
        });
        expect(pod.volumes.find((v: any) => v.name === "openbao-ca")).toEqual({ name: "openbao-ca", configMap: { name: "rapidmx-server-openbao-ca" } });
        const mounts = pod.containers[0].volumeMounts;
        expect(mounts).toContainEqual({ name: "openbao-token", mountPath: "/var/run/secrets/openbao", readOnly: true });
        expect(mounts).toContainEqual({ name: "openbao-ca", mountPath: "/etc/rapidmx/openbao-ca", readOnly: true });

        const config = serverConfig(all);
        for (const client of ["pki", "secrets"]) {
            expect(config[`mail__${client}__openbao__address`], client).toBe("https://openbao.openbao.svc:8200");
            expect(config[`mail__${client}__openbao__ca_file`], client).toBe("/etc/rapidmx/openbao-ca/ca.crt");
            expect(config[`mail__${client}__openbao__auth__method`], client).toBe("kubernetes");
            expect(config[`mail__${client}__openbao__auth__role`], client).toBe("rapidmx-server-server");
            expect(config[`mail__${client}__openbao__auth__mount_path`], client).toBe("kubernetes");
            expect(config[`mail__${client}__openbao__auth__token_file`], client).toBe("/var/run/secrets/openbao/token");
        }
        // The PKI mount and role the installer creates; the encryption CA stays "local" unless mail__pki__backend says otherwise.
        expect(config.mail__pki__openbao__mount).toBe("pki");
        expect(config.mail__pki__openbao__role).toBe("rapidmx-encryption");
        expect(config.mail__pki__backend).toBeUndefined();
    });

    it("takes the server's role and audience from values", () => {
        const all = render(...INSTALLER, "openbao.auth.role=mail-server", "openbao.auth.audience=vault-prod", "openbao.auth.mountPath=k3s");
        expect(serverConfig(all).mail__pki__openbao__auth__role).toBe("mail-server");
        expect(serverConfig(all).mail__secrets__openbao__auth__mount_path).toBe("k3s");
        expect(serverPod(all).volumes.find((v: any) => v.name === "openbao-token").projected.sources[0].serviceAccountToken.audience).toBe("vault-prod");
    });

    it("refuses Kubernetes auth for the server when it runs as no ServiceAccount of its own", () => {
        expect(() => render(...INSTALLER, "global.serviceAccount.create=false")).toThrow(/openbao\.auth\.method is "kubernetes"/);
        // Naming the namespace's default ServiceAccount is the same thing.
        expect(() => render(...INSTALLER, "global.serviceAccount.create=false", "global.serviceAccount.name=default")).toThrow(
            /openbao\.auth\.method is "kubernetes"/
        );
        // A ServiceAccount of its own, created elsewhere, is fine.
        expect(serverPod(render(...INSTALLER, "global.serviceAccount.create=false", "global.serviceAccount.name=rapidmx-mail")).serviceAccountName).toBe("rapidmx-mail");
    });

    it("gives the server's clients a static token from a Secret, for a vault prepared by hand, and never from the ConfigMap", () => {
        const all = render("openbao.auth.method=token", "openbao.auth.tokenSecret=rapidmx-openbao-token");
        const env = serverPod(all).containers[0].env.filter((e: any) => /openbao__token$/.test(e.name));
        expect(env).toEqual(
            ["pki", "secrets"].map((client) => ({
                name: `mail__${client}__openbao__token`,
                valueFrom: { secretKeyRef: { name: "rapidmx-openbao-token", key: "token" } },
            }))
        );
        expect(Object.keys(serverConfig(all)).filter((key) => key.endsWith("__token"))).toEqual([]);
        // No identity at all (the default) sends no token.
        expect(JSON.stringify(serverPod(render()).containers[0].env)).not.toContain("openbao__token");

        expect(() => render("openbao.auth.method=token")).toThrow(/openbao\.auth\.tokenSecret is empty/);
        for (const key of ["mail__pki__openbao__token", "mail__secrets__openbao__token"]) {
            expect(() => render(`service.config.${key}=s.static`)).toThrow(new RegExp(`service\\.config\\.${key} would put an OpenBao token in the server's ConfigMap`));
        }
    });

    it("refuses External Secrets logging in as the server's own ServiceAccount", () => {
        expect(() => render(...INSTALLER, "global.openbao.auth.kubernetes.serviceAccount=rapidmx-server")).toThrow(/needs one of its own/);
    });

    it("grants nothing new in Kubernetes: no ClusterRole, and no Role beyond the Diagnostics read access", () => {
        const all = render(...INSTALLER);
        expect(all.filter((d) => d.kind === "ClusterRole" || d.kind === "ClusterRoleBinding")).toEqual([]);
        for (const role of all.filter((d) => d.kind === "Role")) {
            for (const rule of (role as any).rules) {
                expect(rule.verbs.every((verb: string) => ["get", "list", "watch"].includes(verb)), role.metadata?.name).toBe(true);
            }
        }
    });
});
