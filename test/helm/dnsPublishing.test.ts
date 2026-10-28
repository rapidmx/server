///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { spawnSync } from "child_process";
import fs from "fs";
import { loadAll } from "js-yaml";
import path from "path";

// Renders the real chart with `helm template` to check what DNS publishing adds (restapi specs/dns_publishing_and_integrations.md, 7.2, 7.4, 7.6, 8, 12.5
// and 13.1): the DNS controller's Deployment, ServiceAccount, Role and RoleBinding with its projected token (no Service, NetworkPolicy or server subject),
// the external-dns ServiceAccount and Role, the server's `mail__domains`, `mail__dns__publish__*` and bootstrap-provider settings, the optional mount of the
// installer's credentials Secret, and the openpgpkey host's default. Skipped where `helm` isn't installed or the chart's dependencies haven't been fetched
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
    // The keyring is generated only where `lookup` can keep it (a render without cluster access refuses), else it is a Secret you manage.
    "configEncryption.existingSecret=keyring",
    "global.openbao.enabled=false",
    // The controller has no published release yet, so the chart pins none: the renders that turn publishing on name one, as an installer will.
    "dns.controller.image.tag=0.1.0",
    "mail.rspamd.controller.password=abcdefghijklmnop1",
    "coturn.auth.sharedSecret=abc123",
    "authserver.service.config.auth__oauth_server__keys__encryption_key=" + "0123456789abcdef".repeat(4),
    "authserver.service.config.auth__totp__encryption_key=" + "fedcba9876543210".repeat(4),
];

const ON = "dns.publishing.enabled=true";

interface Rule {
    apiGroups: string[];
    resources: string[];
    resourceNames?: string[];
    verbs: string[];
}

interface Doc {
    kind?: string;
    metadata?: { name?: string; annotations?: Record<string, string>; labels?: Record<string, string> };
    spec?: any;
    data?: Record<string, string>;
    rules?: Rule[];
    roleRef?: { kind: string; name: string };
    subjects?: { kind: string; name: string; namespace?: string }[];
}

function helm(sets: string[], json: string[]): { status: number | null; stdout: string; stderr: string } {
    const args = ["template", "rapidmx", CHART, "--namespace", "rapidmx"];
    for (const s of [...BASE, ...sets]) {
        args.push("--set", s);
    }
    for (const s of json) {
        args.push("--set-json", s);
    }
    return spawnSync("helm", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function render(sets: string[] = [], json: string[] = []): Doc[] {
    const res = helm(sets, json);
    if (res.status !== 0) {
        throw new Error(res.stderr);
    }
    return (loadAll(res.stdout) as Doc[]).filter((d) => d && typeof d === "object");
}

const find = (all: Doc[], kind: string, name: string) => all.find((d) => d.kind === kind && d.metadata?.name === name);
const CONTROLLER = "rapidmx-server-dns-controller";
const EXTERNAL_DNS = "rapidmx-server-external-dns";
const controller = (all: Doc[]) => find(all, "Deployment", CONTROLLER)!;
const server = (all: Doc[]) => find(all, "Deployment", "rapidmx-server-services")!;
const serverConfig = (all: Doc[]) => find(all, "ConfigMap", "rapidmx-server-service-config")!.data!;
const env = (deployment: Doc): Record<string, any> =>
    Object.fromEntries((deployment.spec.template.spec.containers[0].env ?? []).map((e: any) => [e.name, e.value ?? e])) as Record<string, any>;
const json = (value: string | undefined) => JSON.parse(value ?? "null");

/** A rule with its verbs and resources in a fixed order, so a comparison doesn't depend on how the template lists them. */
const normalize = (rules: Rule[] = []) =>
    rules.map((r) => ({ ...r, resources: [...r.resources].sort(), verbs: [...r.verbs].sort() })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

const CLOUDFLARE = '{"name":"cloudflare","type":"cloudflare","zones":["example.com"],"options":{"zoneIds":["0123456789abcdef0123456789abcdef"]}}';

describe.skipIf(!helmAvailable || !depsAvailable)("chart: DNS publishing", () => {
    vi.setConfig({ testTimeout: 60000 });

    describe("off (the default)", () => {
        it("renders none of the controller, external-dns or their rights", () => {
            const all = render();
            const named = all.filter((d) => /dns-controller|external-dns/.test(JSON.stringify(d.metadata ?? {}))).map((d) => `${d.kind}/${d.metadata?.name}`);
            expect(named).toEqual([]);
        });

        it("sets no publishing settings on the server, and keeps the seeded domains, which don't depend on it", () => {
            const config = serverConfig(render());
            expect(Object.keys(config).filter((k) => k.startsWith("mail__dns__") && k !== "mail__dns__mx_hostname")).toEqual([]);
            expect(json(config.mail__domains)).toEqual(["example.com"]);
        });
    });

    describe("on", () => {
        it("runs the controller from the pinned image: one replica, Recreate, its own ServiceAccount", () => {
            const all = render([ON]);
            const deployment = controller(all);
            expect(deployment).toBeDefined();
            expect(deployment.spec.replicas).toBe(1);
            expect(deployment.spec.strategy).toEqual({ type: "Recreate" });
            const pod = deployment.spec.template.spec;
            expect(pod.serviceAccountName).toBe(CONTROLLER);
            expect(find(all, "ServiceAccount", CONTROLLER)).toBeDefined();
            expect(pod.containers).toHaveLength(1);
            expect(pod.containers[0].image).toMatch(/^ghcr\.io\/rapidmx\/dns-controller:\d+\.\d+\.\d+$/);
            expect(pod.containers[0].imagePullPolicy).toBe("IfNotPresent");
        });

        it("pins the images: the controller to a release, external-dns to v0.23.0 by digest", () => {
            const values = loadAll(fs.readFileSync(path.join(CHART, "values.yaml"), "utf8").replace(/\{\{[^}]*\}\}/g, "x"))[0] as any;
            expect(values.dns.controller.image).toMatchObject({ registry: "ghcr.io", repository: "rapidmx/dns-controller", digest: "" });
            // Never a floating tag; and none at all until the controller's first release is published, so that enabling publishing fails the render
            // instead of pulling an image that does not exist.
            expect(values.dns.controller.image.tag).toMatch(/^(\d+\.\d+\.\d+)?$/);
            expect(values.dns.externalDns.image).toMatch(/^registry\.k8s\.io\/external-dns\/external-dns:v0\.23\.0@sha256:[0-9a-f]{64}$/);
        });

        it("runs a digest instead of the tag when one is set", () => {
            const digest = "sha256:" + "ab".repeat(32);
            const image = controller(render([ON, `dns.controller.image.digest=${digest}`])).spec.template.spec.containers[0].image;
            expect(image).toBe(`ghcr.io/rapidmx/dns-controller@${digest}`);
            expect(controller(render([ON, "dns.controller.image.tag=9.8.7"])).spec.template.spec.containers[0].image).toBe("ghcr.io/rapidmx/dns-controller:9.8.7");
        });

        it("refuses to render without a release to run, which the chart's own default is until one is published", () => {
            const res = helm([ON, "dns.controller.image.tag="], []);
            expect(res.status).not.toBe(0);
            expect(res.stderr).toMatch(/dns\.controller\.image/);
            // Off, nothing needs the image.
            expect(helm(["dns.controller.image.tag="], []).status).toBe(0);
        });

        it("waits for the server's long poll with a margin, and reports at its own interval, only when asked to differ from its defaults", () => {
            const unset = env(controller(render([ON])));
            expect(unset.DNS_CONTROLLER_LONG_POLL_TIMEOUT_SECONDS).toBeUndefined();
            expect(unset.DNS_CONTROLLER_STATUS_INTERVAL_SECONDS).toBeUndefined();
            const poll = (seconds: number) => env(controller(render([ON, `service.config.mail__dns__desired_state__long_poll_seconds=${seconds}`]))).DNS_CONTROLLER_LONG_POLL_TIMEOUT_SECONDS;
            // The server's default wait (55) and anything below it fit the controller's 75.
            expect(poll(30)).toBeUndefined();
            // A raised wait would otherwise end every idle poll as a client timeout.
            expect(poll(90)).toBe("110");
            expect(poll(900)).toBe("900");
            const set = env(
                controller(render([ON, "dns.controller.longPollTimeoutSeconds=120", "dns.controller.statusIntervalSeconds=30", "service.config.mail__dns__desired_state__long_poll_seconds=90"]))
            );
            expect(set.DNS_CONTROLLER_LONG_POLL_TIMEOUT_SECONDS).toBe("120");
            expect(set.DNS_CONTROLLER_STATUS_INTERVAL_SECONDS).toBe("30");
        });

        it("trusts the CA of the server's certificate for the call to it, when one is named", () => {
            const POD = "global.gateway.tlsTermination=pod";
            const plain = controller(render([ON, POD]));
            expect(env(plain).NODE_EXTRA_CA_CERTS).toBeUndefined();
            expect(plain.spec.template.spec.volumes).toHaveLength(1);
            const withCA = controller(render([ON, POD, "dns.controller.serverCA.configMap=issuer-ca"]));
            const pod = withCA.spec.template.spec;
            expect(env(withCA).NODE_EXTRA_CA_CERTS).toBe("/etc/rapidmx/server-ca/ca.crt");
            expect(pod.volumes).toContainEqual({ name: "server-ca", configMap: { name: "issuer-ca" } });
            expect(pod.containers[0].volumeMounts).toContainEqual({ name: "server-ca", mountPath: "/etc/rapidmx/server-ca", readOnly: true });
            const keyed = controller(render([ON, "dns.controller.serverCA.configMap=issuer-ca", "dns.controller.serverCA.key=bundle.pem"]));
            expect(env(keyed).NODE_EXTRA_CA_CERTS).toBe("/etc/rapidmx/server-ca/bundle.pem");
        });

        it("configures the controller from the release, with none of the removed internal API's settings", () => {
            const all = render([ON, "dns.controller.resyncMinutes=15"]);
            const values = env(controller(all));
            const pin = serverConfig(all).mail__dns__publish__external_dns_image;
            expect(values).toMatchObject({
                DNS_CONTROLLER_SERVER_URL: "http://rapidmx-server-services/internal/dns",
                DNS_CONTROLLER_LEASE_NAME: CONTROLLER,
                DNS_CONTROLLER_FULLNAME: "rapidmx-server",
                DNS_CONTROLLER_RELEASE: "rapidmx",
                DNS_CONTROLLER_EXTERNAL_DNS_IMAGE: pin,
                DNS_CONTROLLER_EXTERNAL_DNS_SERVICE_ACCOUNT: EXTERNAL_DNS,
                DNS_CONTROLLER_RESYNC_MINUTES: "15",
            });
            expect(values.POD_NAME).toEqual({ name: "POD_NAME", valueFrom: { fieldRef: { fieldPath: "metadata.name" } } });
            // The token file is the controller's default, so the variable isn't needed.
            expect(Object.keys(values).filter((k) => /SERVER_SUBJECT|API_PORT|API_AUDIENCE|OPENBAO|EXTERNAL_SECRETS/.test(k))).toEqual([]);
        });

        it("reaches the server over TLS when the pod terminates it, as postfix-bridge does", () => {
            const url = env(controller(render([ON, "global.gateway.tlsTermination=pod"]))).DNS_CONTROLLER_SERVER_URL;
            expect(url).toBe("https://rapidmx-server-services/internal/dns");
        });

        it("passes external-dns's resources to the controller only when set", () => {
            expect(env(controller(render([ON]))).DNS_CONTROLLER_EXTERNAL_DNS_RESOURCES).toBeUndefined();
            const set = env(controller(render([ON], ['dns.externalDns.resources={"requests":{"cpu":"20m","memory":"64Mi"}}'])));
            expect(json(set.DNS_CONTROLLER_EXTERNAL_DNS_RESOURCES)).toEqual({ requests: { cpu: "20m", memory: "64Mi" } });
        });

        it("gives it a projected token for the server's audience, read-only, and nothing else to mount", () => {
            const pod = controller(render([ON])).spec.template.spec;
            expect(pod.volumes).toEqual([
                { name: "internal-dns-token", projected: { sources: [{ serviceAccountToken: { audience: "rapidmx-internal-dns", expirationSeconds: 3600, path: "token" } }] } },
            ]);
            expect(pod.containers[0].volumeMounts).toEqual([{ name: "internal-dns-token", mountPath: "/var/run/secrets/rapidmx/internal-dns", readOnly: true }]);
            // No database, Redis, keyring or other Secret: not as a volume, an environment source or an environment variable.
            expect(pod.containers[0].envFrom).toBeUndefined();
            const text = JSON.stringify(controller(render([ON])));
            expect(text).not.toMatch(/secretRef|secretKeyRef|secretName|configMapRef|config-keyring|jwt-auth|db-info/);
        });

        it("is hardened: non-root, read-only root, no capabilities, the runtime's seccomp profile", () => {
            const pod = controller(render([ON])).spec.template.spec;
            expect(pod.securityContext).toMatchObject({ runAsNonRoot: true, runAsUser: 65532, runAsGroup: 65532, seccompProfile: { type: "RuntimeDefault" } });
            expect(pod.containers[0].securityContext).toEqual({ allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] } });
        });

        it("serves only its health endpoints, and the kubelet probes them", () => {
            const container = controller(render([ON])).spec.template.spec.containers[0];
            expect(container.ports).toEqual([{ name: "health", containerPort: 8081 }]);
            expect(container.livenessProbe.httpGet).toMatchObject({ path: "/healthz", port: "health" });
            expect(container.readinessProbe.httpGet).toMatchObject({ path: "/readyz", port: "health" });
            expect(container.resources.requests).toBeDefined();
        });

        it("takes resources from the values", () => {
            const container = controller(render([ON], ['dns.controller.resources={"requests":{"cpu":"50m","memory":"96Mi"},"limits":{"memory":"192Mi"}}'])).spec.template.spec.containers[0];
            expect(container.resources).toEqual({ requests: { cpu: "50m", memory: "96Mi" }, limits: { memory: "192Mi" } });
        });

        it("has no Service, no NetworkPolicy and no route to it: nothing calls the controller", () => {
            const all = render([ON]);
            const pod = controller(all).spec.template.metadata.labels;
            expect(pod.app).toBe("dns-controller");
            for (const d of all.filter((d) => ["Service", "NetworkPolicy", "HTTPRoute", "TLSRoute", "Ingress"].includes(d.kind ?? ""))) {
                expect(JSON.stringify(d)).not.toMatch(/dns-controller/);
                expect(d.spec?.selector).not.toMatchObject({ app: "dns-controller" });
            }
            // It is not one of the server's pods: the server's rollout check and Services select app=server.
            expect(pod.app).not.toBe(server(all).spec.selector.matchLabels.app);
        });
    });

    describe("rights", () => {
        it("gives the controller a namespaced Role of exactly the verbs it needs, bound to its ServiceAccount", () => {
            const all = render([ON]);
            const role = find(all, "Role", CONTROLLER)!;
            expect(normalize(role.rules)).toEqual(
                normalize([
                    { apiGroups: ["apps"], resources: ["deployments"], verbs: ["get", "list", "watch", "create", "update", "patch", "delete"] },
                    { apiGroups: [""], resources: ["secrets"], verbs: ["get", "create", "update", "patch", "delete"] },
                    { apiGroups: [""], resources: ["pods"], verbs: ["get", "list"] },
                    { apiGroups: ["batch"], resources: ["jobs"], verbs: ["get", "list", "create", "delete"] },
                    { apiGroups: ["externaldns.k8s.io"], resources: ["dnsendpoints"], verbs: ["get", "list", "watch", "create", "update", "patch", "delete"] },
                    // A create can't be limited to a name; reading and renewing the Lease can.
                    { apiGroups: ["coordination.k8s.io"], resources: ["leases"], verbs: ["create"] },
                    { apiGroups: ["coordination.k8s.io"], resources: ["leases"], resourceNames: [CONTROLLER], verbs: ["get", "update"] },
                ])
            );
            const binding = find(all, "RoleBinding", CONTROLLER)!;
            expect(binding.roleRef).toMatchObject({ kind: "Role", name: CONTROLLER });
            expect(binding.subjects).toEqual([{ kind: "ServiceAccount", name: CONTROLLER, namespace: "rapidmx" }]);
        });

        it("gives external-dns a ServiceAccount and a Role that reads the DNSEndpoints and writes their status, nothing else", () => {
            const all = render([ON]);
            expect(find(all, "ServiceAccount", EXTERNAL_DNS)).toBeDefined();
            expect(normalize(find(all, "Role", EXTERNAL_DNS)!.rules)).toEqual(
                normalize([
                    { apiGroups: ["externaldns.k8s.io"], resources: ["dnsendpoints"], verbs: ["get", "list", "watch"] },
                    { apiGroups: ["externaldns.k8s.io"], resources: ["dnsendpoints/status"], verbs: ["update"] },
                ])
            );
            const binding = find(all, "RoleBinding", EXTERNAL_DNS)!;
            expect(binding.roleRef).toMatchObject({ kind: "Role", name: EXTERNAL_DNS });
            expect(binding.subjects).toEqual([{ kind: "ServiceAccount", name: EXTERNAL_DNS, namespace: "rapidmx" }]);
        });

        it("annotates external-dns's ServiceAccount from the values, where Route 53 without keys gets its IAM role", () => {
            const arn = "arn:aws:iam::123456789012:role/external-dns";
            const sa = find(render([ON], [`dns.externalDns.serviceAccount.annotations={"eks.amazonaws.com/role-arn":"${arn}"}`]), "ServiceAccount", EXTERNAL_DNS)!;
            expect(sa.metadata?.annotations).toEqual({ "eks.amazonaws.com/role-arn": arn });
        });

        it("grants no cluster-wide right, and the server's Roles gain nothing", () => {
            const on = render([ON]);
            const off = render();
            expect(on.filter((d) => d.kind === "ClusterRole" || d.kind === "ClusterRoleBinding")).toEqual([]);
            // Every Role that exists without publishing is as it was.
            for (const role of off.filter((d) => d.kind === "Role")) {
                expect(find(on, "Role", role.metadata!.name!)!.rules).toEqual(role.rules);
            }
            // The write rights are the controller's and the keyring's, and only those.
            const writers = on.filter((d) => d.kind === "Role" && d.rules!.some((rule) => rule.verbs.some((verb) => !["get", "list", "watch"].includes(verb))));
            expect(writers.map((d) => d.metadata?.name).sort()).toEqual([CONTROLLER, EXTERNAL_DNS, "keyring"].sort());
            // The server is not bound to either of them.
            for (const binding of on.filter((d) => d.kind === "RoleBinding" && [CONTROLLER, EXTERNAL_DNS].includes(d.metadata?.name ?? ""))) {
                expect(binding.subjects!.map((s) => s.name)).not.toContain("rapidmx-server");
            }
        });
    });

    describe("the server's settings", () => {
        it("trusts the controller's ServiceAccount, and says what to publish", () => {
            const all = render([ON]);
            const config = serverConfig(all);
            expect(config.mail__dns__controller__subject).toBe(`system:serviceaccount:rapidmx:${CONTROLLER}`);
            expect(config.mail__dns__publish__ttl).toBe("300");
            expect(config.mail__dns__publish__external_dns_image).toMatch(/^registry\.k8s\.io\/external-dns\/external-dns:v0\.23\.0@sha256:[0-9a-f]{64}$/);
            expect(json(config.mail__dns__publish__addresses)).toEqual([]);
        });

        it("takes the TTL, the image and the public addresses from the values", () => {
            const config = serverConfig(
                render([ON, "dns.ttl=600", "dns.externalDns.image=registry.example/external-dns:v0.23.0"], ['dns.publicAddresses=["203.0.113.7","2001:db8::7"]'])
            );
            expect(config.mail__dns__publish__ttl).toBe("600");
            expect(config.mail__dns__publish__external_dns_image).toBe("registry.example/external-dns:v0.23.0");
            expect(json(config.mail__dns__publish__addresses)).toEqual(["203.0.113.7", "2001:db8::7"]);
        });

        it("renders the hosts it serves: the addresses of the mail host and the auth host, CNAMEs to the mail host for the others, and none for a host it doesn't serve", () => {
            const hosts = (...sets: string[]) => json(serverConfig(render([ON, ...sets])).mail__dns__publish__hosts);
            // The chart answers autodiscover.<domain> on its Gateway and Certificate whether or not the plugin is installed.
            expect(hosts()).toEqual([
                { name: "mail.example.com", type: "address" },
                { name: "auth.example.com", type: "address" },
                { name: "autodiscover.example.com", type: "cname" },
            ]);
            expect(hosts("mail.wkd.openpgpkeyHost.enabled=true")).toEqual([
                { name: "mail.example.com", type: "address" },
                { name: "auth.example.com", type: "address" },
                { name: "autodiscover.example.com", type: "cname" },
                { name: "openpgpkey.example.com", type: "cname" },
            ]);
            // No bundled auth-server, no auth host.
            expect(hosts("authserver.create=false").map((h: any) => h.name)).toEqual(["mail.example.com", "autodiscover.example.com"]);
            // The mail host is the one mail:dns:mx_hostname names.
            expect(hosts("mail.mxHostname=mx.example.com")[0]).toEqual({ name: "mx.example.com", type: "address" });
            // The auth host has A/AAAA records on every existing install and a CNAME cannot sit next to them, so it is published as the mail host is.
            expect(hosts("authserver.host=login.example.com")[1]).toEqual({ name: "login.example.com", type: "address" });
        });

        it("renders the host the chart is reached at, which it certifies and routes, when it is not the mail host", () => {
            const hosts = (...sets: string[]) => json(serverConfig(render([ON, ...sets])).mail__dns__publish__hosts);
            expect(hosts("host=webmail.example.com")).toEqual([
                { name: "mail.example.com", type: "address" },
                { name: "webmail.example.com", type: "cname" },
                { name: "auth.example.com", type: "address" },
                { name: "autodiscover.example.com", type: "cname" },
            ]);
            // The same name in other letters, or the mail host itself (mail.mxHostname), is the mail host's address record and nothing more.
            expect(hosts("host=Mail.Example.com").map((h: any) => h.name)).toEqual(["mail.example.com", "auth.example.com", "autodiscover.example.com"]);
            expect(hosts("host=mx.example.com", "mail.mxHostname=mx.example.com").map((h: any) => h.name)).toEqual(["mx.example.com", "auth.example.com", "autodiscover.example.com"]);
        });

        it("keeps mail__dns__mx_hostname as it was", () => {
            expect(serverConfig(render()).mail__dns__mx_hostname).toBe("mail.example.com");
            expect(serverConfig(render(["mail.mxHostname=mx.example.com"])).mail__dns__mx_hostname).toBe("mx.example.com");
        });
    });

    describe("mail__domains", () => {
        const domains = (sets: string[] = [], jsonSets: string[] = []) => json(serverConfig(render(sets, jsonSets)).mail__domains);

        it("defaults to the install domain and the domains Postfix is started for, each once", () => {
            expect(domains()).toEqual(["example.com"]);
            expect(domains(["postfixBridge.domains=example.com\\,example.org\\, example.net"])).toEqual(["example.com", "example.org", "example.net"]);
            expect(domains(["postfixBridge.domains=example.org\\,example.com"])).toEqual(["example.com", "example.org"]);
        });

        it("names the installer's DNS provider on each when there is one, whether or not publishing is on yet", () => {
            const bootstrap = [
                { name: "example.com", dnsProvider: "bootstrap" },
                { name: "example.org", dnsProvider: "bootstrap" },
            ];
            const two = "postfixBridge.domains=example.com\\,example.org";
            expect(domains([ON, two], [`dns.bootstrapProvider=${CLOUDFLARE}`])).toEqual(bootstrap);
            // The server creates the config at its first start, and a domain seeded without it is never assigned to it afterwards.
            expect(domains([two], [`dns.bootstrapProvider=${CLOUDFLARE}`])).toEqual(bootstrap);
        });

        it("names none when there is none, as the providers are managed in the console", () => {
            expect(domains([ON, "postfixBridge.domains=example.com\\,example.org"])).toEqual(["example.com", "example.org"]);
        });

        it("takes an explicit list as it is, objects included, and leaves the provider to its entries", () => {
            const list = '["a.example.com",{"name":"b.example.com","dnsProvider":"console-made","dmarcPolicy":"reject"},{"name":"c.example.com","aliasOf":"a.example.com"}]';
            expect(domains([ON], [`mail.domains=${list}`, `dns.bootstrapProvider=${CLOUDFLARE}`])).toEqual(JSON.parse(list));
        });

        it("accepts a comma-separated string, as the server does", () => {
            expect(domains(["mail.domains=a.example.com\\,b.example.com"])).toEqual(["a.example.com", "b.example.com"]);
        });
    });

    describe("the installer's DNS provider", () => {
        it("sets and mounts nothing without one", () => {
            const all = render([ON]);
            expect(serverConfig(all).mail__dns__bootstrap_provider).toBeUndefined();
            expect(JSON.stringify(server(all))).not.toContain("dns-bootstrap");
        });

        it("passes the non-secret part to the server and mounts the credentials Secret read-only, optional, into the server alone", () => {
            const all = render([ON], [`dns.bootstrapProvider=${CLOUDFLARE}`]);
            expect(json(serverConfig(all).mail__dns__bootstrap_provider)).toEqual(JSON.parse(CLOUDFLARE));
            const pod = server(all).spec.template.spec;
            expect(pod.containers[0].volumeMounts).toContainEqual({ name: "dns-bootstrap", mountPath: "/etc/rapidmx/dns-bootstrap", readOnly: true });
            expect(pod.volumes).toContainEqual({ name: "dns-bootstrap", secret: { secretName: "rapidmx-server-dns-bootstrap", optional: true } });
            // Not as environment, not in a checksum (the installer deletes it once the rollout is ready), and no other workload mounts it.
            expect(pod.containers[0].envFrom.map((e: any) => e.secretRef?.name)).not.toContain("rapidmx-server-dns-bootstrap");
            expect(JSON.stringify(server(all).spec.template.metadata.annotations)).not.toContain("bootstrap");
            const mounting = all.filter((d) => ["Deployment", "StatefulSet", "DaemonSet", "Job", "CronJob"].includes(d.kind ?? "") && JSON.stringify(d).includes("dns-bootstrap"));
            expect(mounting.map((d) => d.metadata?.name)).toEqual(["rapidmx-server-services"]);
        });

        it("is the server's whether or not the controller runs", () => {
            const all = render([], [`dns.bootstrapProvider=${CLOUDFLARE}`]);
            expect(serverConfig(all).mail__dns__bootstrap_provider).toBeDefined();
            expect(find(all, "Deployment", CONTROLLER)).toBeUndefined();
        });
    });

    describe("the openpgpkey host", () => {
        // The names the Certificates of `host` cover (the auth-server subchart renders one for it too).
        const names = (all: Doc[], host = "mail.example.com"): string[] => all.filter((d) => d.kind === "Certificate" && d.spec?.commonName === host).flatMap((d) => d.spec.dnsNames);
        const HOST = "openpgpkey.example.com";

        it("stays off by default: without a record the Certificate for the server's host would never be issued", () => {
            expect(names(render())).not.toContain(HOST);
            expect(names(render([ON]))).not.toContain(HOST);
        });

        it("is on by default when a provider config for the install domain comes with the release", () => {
            const all = render([ON], [`dns.bootstrapProvider=${CLOUDFLARE}`]);
            expect(names(all)).toContain(HOST);
            expect(json(serverConfig(all).mail__dns__publish__hosts).map((h: any) => h.name)).toContain(HOST);
        });

        it("is on for a provider whose zone is a parent of the domain, and off for one that isn't", () => {
            const zone = (z: string) => `dns.bootstrapProvider=${CLOUDFLARE.replace('"example.com"', `"${z}"`)}`;
            expect(names(render([ON, "global.domain=mail.example.com", "host=mail.mail.example.com"], [zone("example.com")]), "mail.mail.example.com")).toContain("openpgpkey.mail.example.com");
            expect(names(render([ON], [zone("example.org")]))).not.toContain(HOST);
            // A zone that merely ends in the same letters doesn't cover it.
            expect(names(render([ON], [zone("ample.com")]))).not.toContain(HOST);
        });

        it("follows the install into the first step of a two-step install: off when set so, whatever the provider", () => {
            expect(names(render([ON, "mail.wkd.openpgpkeyHost.enabled=false"], [`dns.bootstrapProvider=${CLOUDFLARE}`]))).not.toContain(HOST);
            expect(names(render([ON, "mail.wkd.openpgpkeyHost.enabled=auto"], [`dns.bootstrapProvider=${CLOUDFLARE}`]))).toContain(HOST);
        });

        it("is on when asked for, with or without a provider", () => {
            expect(names(render(["mail.wkd.openpgpkeyHost.enabled=true"]))).toContain(HOST);
        });

        it("refuses a value that is not true, false or auto", () => {
            const res = helm(["mail.wkd.openpgpkeyHost.enabled=sometimes"], []);
            expect(res.status).not.toBe(0);
            expect(res.stderr).toMatch(/openpgpkeyHost\.enabled/);
        });
    });

    describe("turning publishing off", () => {
        // Helm owns none of what the controller creates, so an upgrade to false or an uninstall leaves it: the README says how to remove it, by the labels
        // the controller puts on everything it creates (restapi specs/dns_publishing_and_integrations.md, 7.4).
        it("is documented with the selector the controller labels its objects by, naming the release", () => {
            const readme = fs.readFileSync(path.resolve(__dirname, "../../README.md"), "utf8");
            expect(readme).toContain("-l app.kubernetes.io/managed-by=rapidmx-dns-controller,app.kubernetes.io/instance=<release>");
            // The instance label is the Helm release's name, which is what the Deployment hands the controller.
            expect(env(controller(render([ON]))).DNS_CONTROLLER_RELEASE).toBe("rapidmx");
        });
    });
});
