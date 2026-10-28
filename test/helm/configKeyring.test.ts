///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { parseConfigKeyring } from "@rapidmx/restapi";
import { spawnSync } from "child_process";
import fs from "fs";
import { loadAll } from "js-yaml";
import os from "os";
import path from "path";

// Renders the real chart with `helm template` to check how the configuration keyring (restapi specs/dns_publishing_and_integrations.md,
// 5.3 and 5.5) reaches the server pods: a Secret the chart renders once and keeps (or, with OpenBao, the ExternalSecret that syncs it
// from the vault), mounted read-only into the server pods and no others, with the one Role that lets the server's key rotation replace
// it and no other write right. The chart generates the keyring only while `lookup` finds none, which `helm template` never does and the chart's own
// guard therefore refuses, so the cases about the generated Secret render a copy of the chart with that one guard (rapidmx.assertConfigKeyringStable)
// emptied; the guard itself is rendered from the chart as it is. Skipped where `helm` isn't installed or the chart's dependencies haven't been fetched
// (`helm dependency update ./helm`).
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
];

// What the installers pass for the OpenBao they install (release "rapidmx", so the chart's fullname is "rapidmx-server").
const OPENBAO = [
    "global.openbao.enabled=true",
    "global.openbao.address=https://openbao.openbao.svc:8200",
    "global.openbao.caConfigMap=rapidmx-server-openbao-ca",
    "global.openbao.auth.method=kubernetes",
    "global.openbao.auth.kubernetes.role=rapidmx-server-eso",
    "global.openbao.auth.kubernetes.serviceAccount=rapidmx-server-openbao-eso",
    "global.openbao.auth.kubernetes.audience=openbao",
    "openbao.auth.method=kubernetes",
];

interface Doc {
    kind?: string;
    metadata?: { name?: string; annotations?: Record<string, string>; labels?: Record<string, string> };
    spec?: any;
    data?: Record<string, string>;
    rules?: { apiGroups: string[]; resources: string[]; resourceNames?: string[]; verbs: string[] }[];
    roleRef?: { kind: string; name: string };
    subjects?: { kind: string; name: string; namespace?: string }[];
}

/** Renders a chart the way `helm template` does: with no cluster to `lookup` in. */
function renderChart(chart: string, sets: string[], json: string[] = []): Doc[] {
    // The External Secrets CRDs a real cluster would have (the chart refuses to render its ExternalSecrets without them).
    const args = ["template", "rapidmx", chart, "--namespace", "rapidmx", "--api-versions", "external-secrets.io/v1"];
    for (const s of [...BASE, ...sets]) {
        args.push("--set", s);
    }
    for (const s of json) {
        args.push("--set-json", s);
    }
    const res = spawnSync("helm", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (res.status !== 0) {
        throw new Error(res.stderr);
    }
    return (loadAll(res.stdout) as Doc[]).filter((d) => d && typeof d === "object");
}

/** A copy of the chart with the guard against generating the keyring without a cluster to keep it in emptied, and a probe template that hands
 * the chart's own ownership check the Secret `lookup` would have returned (the value `probe`). Made once, removed afterwards. */
let generating = "";
beforeAll(() => {
    if (!helmAvailable || !depsAvailable) {
        return;
    }
    generating = fs.mkdtempSync(path.join(os.tmpdir(), "chart-"));
    fs.cpSync(CHART, generating, { recursive: true });
    const helpers = path.join(generating, "templates/_helpers.tpl");
    const text = fs.readFileSync(helpers, "utf8");
    const guarded = /\{\{- define "rapidmx\.assertConfigKeyringStable" -\}\}[\s\S]*?\{\{- end -\}\}/;
    expect(guarded.test(text)).toBe(true);
    fs.writeFileSync(helpers, text.replace(guarded, '{{- define "rapidmx.assertConfigKeyringStable" -}}{{- end -}}'));
    fs.writeFileSync(
        path.join(generating, "templates/zz-probe.yaml"),
        '{{- if .Values.probe }}\n{{- include "rapidmx.assertConfigKeyringNotOwnedByVault" (dict "existing" .Values.probe "context" .) }}\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: probe\n{{- end }}\n'
    );
});
afterAll(() => {
    if (generating) {
        fs.rmSync(generating, { recursive: true, force: true });
    }
});

/** Renders the chart with the keyring generated, as it is on a cluster that has none. */
const render = (...sets: string[]): Doc[] => renderChart(generating, sets);
/** Renders the chart exactly as it is. */
const renderReal = (...sets: string[]): Doc[] => renderChart(CHART, sets);

const NAME = "rapidmx-server-config-keyring";
const find = (all: Doc[], kind: string, name: string) => all.find((d) => d.kind === kind && d.metadata?.name === name);
const server = (all: Doc[]) => find(all, "Deployment", "rapidmx-server-services")!;
const serverPod = (all: Doc[]) => server(all).spec.template.spec;
const serverConfig = (all: Doc[]) => find(all, "ConfigMap", "rapidmx-server-service-config")!.data!;
const decode = (value: string) => Buffer.from(value, "base64").toString("utf8");

describe.skipIf(!helmAvailable || !depsAvailable)("chart: the configuration keyring", () => {
    vi.setConfig({ testTimeout: 60000 });

    describe("without OpenBao", () => {
        it("renders the keyring Secret with a new keyring: one key, 32 bytes, an 8-hex kid and a date", () => {
            const all = render();
            const secret = find(all, "Secret", NAME)!;
            expect(secret).toBeDefined();
            expect(Object.keys(secret.data!)).toEqual(["keyring.json"]);
            // The very parser the server reads the file with.
            const keyring = parseConfigKeyring(decode(secret.data!["keyring.json"]));
            expect(keyring.keys).toHaveLength(1);
            expect(keyring.keys[0].kid).toMatch(/^[0-9a-f]{8}$/);
            expect(Buffer.from(keyring.keys[0].key, "base64")).toHaveLength(32);
            expect(Date.now() - Date.parse(keyring.keys[0].createdAt)).toBeLessThan(5 * 60 * 1000);
            expect(find(all, "ExternalSecret", NAME)).toBeUndefined();

            // Generated, not derived from anything fixed: another render is another key.
            const other = parseConfigKeyring(decode(find(render(), "Secret", NAME)!.data!["keyring.json"]));
            expect(other.keys[0].key).not.toBe(keyring.keys[0].key);
        });

        it("tells Helm to keep it when the release is uninstalled", () => {
            const secret = find(render(), "Secret", NAME)!;
            expect(secret.metadata?.annotations?.["helm.sh/resource-policy"]).toBe("keep");
        });

        it("creates it in a hook, so the release's stored manifests never hold a ring that a rollback could put back over a rotated one", () => {
            // Helm rolls back to the manifest of the target revision: a Secret in it is replaced (`--force`) by the ring it was first rendered
            // with, dropping every key a rotation added since. A hook's resources aren't in the manifest, and a rollback runs no pre-install/upgrade hook.
            const secret = find(render(), "Secret", NAME)!;
            expect(secret.metadata?.annotations?.["helm.sh/hook"]).toBe("pre-install,pre-upgrade");
            // Not recreated by Helm: a delete policy would delete the live ring before the hook renders it again.
            expect(secret.metadata?.annotations?.["helm.sh/hook-delete-policy"]).toBeUndefined();
        });

        it("refuses to generate it in a render without cluster access, where it could never be kept (a GitOps controller, helm template)", () => {
            // Every sync would otherwise apply a new random ring over the live one, and everything encrypted with it would be lost.
            expect(() => renderReal()).toThrow(/without cluster access[\s\S]*configEncryption\.existingSecret/);
        });

        it("mounts and updates a Secret you manage instead, and renders none of its own, when configEncryption.existingSecret names one", () => {
            const all = renderReal("configEncryption.existingSecret=gitops-keyring");
            expect(all.filter((d) => d.kind === "Secret" && d.metadata?.name?.includes("keyring"))).toEqual([]);
            expect(serverPod(all).volumes).toContainEqual({ name: "config-keyring", secret: { secretName: "gitops-keyring" } });
            expect(serverConfig(all).config_encryption__keyring_store__secret_name).toBe("gitops-keyring");
            // The rotation may replace that Secret (and only that one), unless the Role is turned off.
            expect(find(all, "Role", "gitops-keyring")!.rules).toEqual([{ apiGroups: [""], resources: ["secrets"], resourceNames: ["gitops-keyring"], verbs: ["get", "update"] }]);
            expect(find(all, "Role", NAME)).toBeUndefined();
            expect(find(renderReal("configEncryption.existingSecret=gitops-keyring", "configEncryption.rbac.create=false"), "Role", "gitops-keyring")).toBeUndefined();
        });

        describe("a Secret an ExternalSecret owns, now that the render has no ExternalSecret for it", () => {
            // `lookup` can't be made to find a Secret under `helm template`, so the chart's ownership check is handed the Secret it would have found.
            const probe = (secret: object) => renderChart(generating, [], ["probe=" + JSON.stringify(secret)]);
            const owned = { metadata: { name: NAME, ownerReferences: [{ kind: "ExternalSecret", name: NAME }] } };

            it("fails the render, saying how to release the Secret first: Kubernetes would delete it with its ExternalSecret and the next upgrade would make a new ring", () => {
                expect(() => probe(owned)).toThrow(/rapidmx-server-config-keyring was created by an ExternalSecret[\s\S]*delete externalsecret rapidmx-server-config-keyring --cascade=orphan/);
            });

            it("accepts a Secret nothing owns, or owned by something else, and no Secret at all", () => {
                expect(find(probe({ metadata: { name: NAME } }), "ConfigMap", "probe")).toBeDefined();
                expect(find(probe({ metadata: { name: NAME, ownerReferences: [{ kind: "Deployment", name: "x" }] } }), "ConfigMap", "probe")).toBeDefined();
                expect(find(probe({ metadata: {} }), "ConfigMap", "probe")).toBeDefined();
            });
        });

        it("points the server at the mounted file and at the Secret its rotation writes", () => {
            const config = serverConfig(render());
            expect(config.config_encryption__keyring_file).toBe("/etc/rapidmx/config-keyring/keyring.json");
            expect(config.config_encryption__keyring_store__backend).toBe("kubernetes");
            expect(config.config_encryption__keyring_store__secret_name).toBe(NAME);
            // Nothing of the OpenBao store, which the backend doesn't use.
            expect(config.config_encryption__keyring_store__kv_path).toBeUndefined();
        });

        it("grants the server get and update on that one Secret by name, bound to its ServiceAccount, and nothing else", () => {
            const all = render();
            const role = find(all, "Role", NAME)!;
            expect(role).toBeDefined();
            expect(role.rules).toEqual([{ apiGroups: [""], resources: ["secrets"], resourceNames: [NAME], verbs: ["get", "update"] }]);

            const binding = find(all, "RoleBinding", NAME)!;
            expect(binding.roleRef).toMatchObject({ kind: "Role", name: NAME });
            expect(binding.subjects).toEqual([{ kind: "ServiceAccount", name: "rapidmx-server", namespace: "rapidmx" }]);
            expect(serverPod(all).serviceAccountName).toBe("rapidmx-server");
        });

        it("adds no write verb anywhere else: the Diagnostics Role stays read-only, and there is no ClusterRole", () => {
            const all = render();
            expect(all.filter((d) => d.kind === "ClusterRole" || d.kind === "ClusterRoleBinding")).toEqual([]);
            for (const role of all.filter((d) => d.kind === "Role" && d.metadata?.name !== NAME)) {
                for (const rule of role.rules!) {
                    expect(rule.verbs.every((verb) => ["get", "list", "watch"].includes(verb)), role.metadata?.name).toBe(true);
                }
            }
            // The one Role with a write verb has exactly that one verb beyond get, on exactly one named Secret.
            const writers = all.filter((d) => d.kind === "Role" && d.rules!.some((rule) => rule.verbs.some((verb) => !["get", "list", "watch"].includes(verb))));
            expect(writers.map((d) => d.metadata?.name)).toEqual([NAME]);
        });

        it("renders no Role when configEncryption.rbac.create is off, or when the server runs as no ServiceAccount of its own", () => {
            const off = render("configEncryption.rbac.create=false");
            expect(find(off, "Role", NAME)).toBeUndefined();
            expect(find(off, "RoleBinding", NAME)).toBeUndefined();
            // The Secret and the mount do not depend on it.
            expect(find(off, "Secret", NAME)).toBeDefined();

            const noAccount = render("global.serviceAccount.create=false");
            expect(find(noAccount, "Role", NAME)).toBeUndefined();
            expect(find(noAccount, "RoleBinding", NAME)).toBeUndefined();
        });
    });

    describe("with OpenBao", () => {
        it("renders an ExternalSecret that syncs the vault's keyring every minute instead of a Secret of its own", () => {
            const all = render(...OPENBAO);
            expect(find(all, "Secret", NAME)).toBeUndefined();
            const external = find(all, "ExternalSecret", NAME)!;
            expect(external).toBeDefined();
            expect(external.spec.refreshInterval).toBe("1m");
            expect(external.spec.secretStoreRef).toEqual({ name: "rapidmx-server-openbao", kind: "SecretStore" });
            expect(external.spec.target).toMatchObject({ name: NAME, creationPolicy: "Owner" });
            // The vault holds the JSON as the property "keyring"; the Secret has it as the file the pods mount.
            expect(external.spec.target.template.data).toEqual({ "keyring.json": "{{ .keyring }}" });
            // Its own path, so the server's OpenBao role can be limited to it (not a key of <fullname>/secrets).
            expect(external.spec.data).toEqual([{ secretKey: "keyring", remoteRef: { key: "rapidmx-server/config-keyring", property: "keyring" } }]);
        });

        it("takes the refresh interval, the mount and the path from values", () => {
            const all = render(
                ...OPENBAO,
                "configEncryption.externalSecretRefreshInterval=30s",
                "global.openbao.kvMount=kv",
                "configEncryption.openbao.path=prod/keyring"
            );
            const external = find(all, "ExternalSecret", NAME)!;
            expect(external.spec.refreshInterval).toBe("30s");
            expect(external.spec.data[0].remoteRef.key).toBe("prod/keyring");
            const config = serverConfig(all);
            expect(config.config_encryption__keyring_store__kv_mount).toBe("kv");
            expect(config.config_encryption__keyring_store__kv_path).toBe("prod/keyring");
        });

        it("has the server write the vault, not the Kubernetes API: no Role, and the same mounted file", () => {
            const all = render(...OPENBAO);
            const config = serverConfig(all);
            expect(config.config_encryption__keyring_file).toBe("/etc/rapidmx/config-keyring/keyring.json");
            expect(config.config_encryption__keyring_store__backend).toBe("openbao");
            expect(config.config_encryption__keyring_store__kv_mount).toBe("secret");
            expect(config.config_encryption__keyring_store__kv_path).toBe("rapidmx-server/config-keyring");
            expect(config.config_encryption__keyring_store__secret_name).toBeUndefined();

            expect(find(all, "Role", NAME)).toBeUndefined();
            expect(find(all, "RoleBinding", NAME)).toBeUndefined();
            // No Kubernetes write right at all: every Role is read-only.
            for (const role of all.filter((d) => d.kind === "Role")) {
                for (const rule of role.rules!) {
                    expect(rule.verbs.every((verb) => ["get", "list", "watch"].includes(verb)), role.metadata?.name).toBe(true);
                }
            }
        });

        it("has the server write no vault, and rotation refused, when it holds no OpenBao identity to write it with", () => {
            // The vault only feeds External Secrets here (openbao.auth.method empty): a rotation would fail on a missing login, when it is needed.
            const all = render(...OPENBAO.filter((s) => s !== "openbao.auth.method=kubernetes"));
            const config = serverConfig(all);
            expect(config.config_encryption__keyring_store__backend).toBe("none");
            expect(config.config_encryption__keyring_store__kv_path).toBeUndefined();
            expect(config.config_encryption__keyring_store__secret_name).toBeUndefined();
            // The keyring is still delivered and mounted.
            expect(find(all, "ExternalSecret", NAME)).toBeDefined();
            expect(config.config_encryption__keyring_file).toBe("/etc/rapidmx/config-keyring/keyring.json");
        });

        it("has the server write the vault with the token of a Secret it was given, as well as with its own ServiceAccount", () => {
            const all = render(...OPENBAO.filter((s) => s !== "openbao.auth.method=kubernetes"), "openbao.auth.method=token", "openbao.auth.tokenSecret=server-openbao-token");
            expect(serverConfig(all).config_encryption__keyring_store__backend).toBe("openbao");
        });

        it("uses the chart's own Secret when External Secrets is turned off, even with the vault on", () => {
            const all = render(...OPENBAO, "global.externalSecrets.enabled=false");
            expect(find(all, "Secret", NAME)).toBeDefined();
            expect(find(all, "ExternalSecret", NAME)).toBeUndefined();
            expect(find(all, "Role", NAME)).toBeDefined();
            expect(serverConfig(all).config_encryption__keyring_store__backend).toBe("kubernetes");
        });
    });

    describe.each([
        ["without OpenBao", [] as string[]],
        ["with OpenBao", OPENBAO],
    ])("%s", (_name, sets) => {
        it("mounts the Secret read-only into the server pods and no other pod, never as environment", () => {
            const all = render(...sets);
            const pod = serverPod(all);
            expect(pod.volumes).toContainEqual({ name: "config-keyring", secret: { secretName: NAME } });
            expect(pod.containers[0].volumeMounts).toContainEqual({ name: "config-keyring", mountPath: "/etc/rapidmx/config-keyring", readOnly: true });
            expect(JSON.stringify(pod.containers[0].envFrom)).not.toContain("config-keyring");
            expect(JSON.stringify(pod.containers[0].env)).not.toContain("config-keyring");

            // Nothing else in the release (the auth-server, rspamd, clamav, coturn, Postfix, the databases, the test pod) references it.
            const workloads = all.filter((d) => ["Deployment", "StatefulSet", "DaemonSet", "Job", "CronJob", "Pod"].includes(d.kind ?? ""));
            const mounting = workloads.filter((d) => JSON.stringify(d).includes("config-keyring")).map((d) => `${d.kind}/${d.metadata?.name}`);
            expect(mounting).toEqual(["Deployment/rapidmx-server-services"]);
        });

        it("does not roll the pods when the keyring changes: a rotation writes it and the pods re-read the file", () => {
            // The checksum annotations cover the Secrets the pods read at startup; this one is a file re-read every minute.
            const annotations = server(render(...sets)).spec.template.metadata.annotations;
            expect(JSON.stringify(annotations)).not.toContain("keyring");
        });

        it("gives the plugin secrets' rollout check the labels of exactly the server Deployment's pods", () => {
            const all = render(...sets);
            const selector = serverConfig(all).config_encryption__plugin_secrets__pod_selector;
            expect(selector).toBeTruthy();
            const wanted = Object.fromEntries(selector.split(",").map((pair) => pair.split("=")));
            const template = server(all).spec.template.metadata.labels;
            // Every label named is on the server's pods ...
            for (const [key, value] of Object.entries(wanted)) {
                expect(template[key], key).toBe(value);
            }
            // ... including all of the Deployment's own selector labels, so it never matches fewer pods than the Deployment owns,
            // and it adds the instance label so a second release of the chart in the namespace is not mistaken for this one.
            for (const [key, value] of Object.entries(server(all).spec.selector.matchLabels)) {
                expect(wanted[key], key).toBe(value);
            }
            expect(wanted["app.kubernetes.io/instance"]).toBe("rapidmx-server-services");
            // No other workload of the release carries all of them.
            const matching = all
                .filter((d) => ["Deployment", "StatefulSet", "DaemonSet"].includes(d.kind ?? ""))
                .filter((d) => Object.entries(wanted).every(([key, value]) => d.spec?.template?.metadata?.labels?.[key] === value))
                .map((d) => d.metadata?.name);
            expect(matching).toEqual(["rapidmx-server-services"]);
        });
    });
});
