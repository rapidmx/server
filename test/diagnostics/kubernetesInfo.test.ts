///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
import {
    buildComponents,
    classifyPod,
    collectRuntime,
    distributionOf,
    errorMessage,
    listPods,
    nodesOf,
    type KubePod,
} from "../../src/diagnostics/kubernetesInfo.js";

const digest = `sha256:${"b".repeat(64)}`;

function pod(name: string, container: string, image: string, overrides: Partial<KubePod["status"]> & { node?: string; ready?: boolean } = {}): KubePod {
    return {
        metadata: { name, labels: { app: container } },
        spec: { nodeName: overrides.node ?? "node-1", containers: [{ name: container, image }] },
        status: {
            phase: overrides.phase ?? "Running",
            hostIP: overrides.hostIP ?? "10.0.0.5",
            startTime: "2026-09-01T00:00:00Z",
            containerStatuses: [
                { name: container, image, imageID: `docker.io/x@${digest}`, ready: overrides.ready ?? true, restartCount: 2 },
            ],
        },
    };
}

describe("classifyPod", () => {
    it("reads a component pod's containers, readiness and version", () => {
        const classified = classifyPod(pod("rspamd-1", "rspamd", "docker.io/rspamd/rspamd:4.1.5"));
        expect(classified.component).toBe("rspamd");
        expect(classified.version).toBe("4.1.5");
        expect(classified.pod).toMatchObject({
            name: "rspamd-1",
            phase: "Running",
            ready: true,
            restarts: 2,
            node: "node-1",
            startedAt: "2026-09-01T00:00:00Z",
            containers: [{ name: "rspamd", tag: "4.1.5", digest, ready: true, restartCount: 2 }],
        });
        expect(classified.hostIP).toBe("10.0.0.5");
    });

    it("is not ready when a container is not", () => {
        expect(classifyPod(pod("r", "redis", "bitnami/redis:8", { ready: false })).pod.ready).toBe(false);
    });

    it("copes with a pod that has no status yet, and finds its PVC mounts", () => {
        const classified = classifyPod({
            metadata: { name: "srv" },
            spec: {
                containers: [
                    { name: "server", image: "ghcr.io/rapidmx/server:1", volumeMounts: [{ name: "blob", mountPath: "/data" }, { name: "tmp", mountPath: "/tmp" }] },
                ],
                volumes: [{ name: "blob", persistentVolumeClaim: { claimName: "blob-data" } }, { name: "tmp" }],
            },
        });
        expect(classified.component).toBeUndefined();
        expect(classified.pod).toMatchObject({ phase: "Unknown", ready: false, restarts: 0 });
        expect(classified.claims).toEqual([{ claimName: "blob-data", mountPath: "/data" }]);
        expect(classified.labels).toEqual({});
    });

    it("copes with an empty pod", () => {
        expect(classifyPod({}).pod).toMatchObject({ name: "", containers: [], ready: false });
    });

    it("takes a container's image from its status when the spec is missing", () => {
        const classified = classifyPod({
            metadata: { name: "p" },
            status: { containerStatuses: [{ name: "clamav", image: "clamav/clamav:stable", ready: true }] },
        });
        expect(classified.component).toBe("clamav");
        expect(classified.pod.containers[0].image).toBe("clamav/clamav:stable");
    });
});

describe("buildComponents", () => {
    it("is unknown for every component when Kubernetes could not be asked", () => {
        const components = buildComponents(undefined);
        expect(components.map((c) => c.component)).toEqual([
            "postfix", "postfix-bridge", "mongodb", "postgresql", "redis", "coturn", "rspamd", "clamav",
        ]);
        expect(components.every((c) => c.status === "unknown" && c.pods.length === 0)).toBe(true);
    });

    it("reports running, not-ready and missing", () => {
        const components = buildComponents([
            classifyPod(pod("rspamd-1", "rspamd", "rspamd/rspamd:4.1.5")),
            classifyPod(pod("redis-0", "redis", "bitnami/redis:8", { ready: false })),
            classifyPod(pod("redis-1", "redis", "bitnami/redis:8", { ready: false })),
            classifyPod(pod("srv", "server", "ghcr.io/rapidmx/server:1")),
        ]);
        const by = Object.fromEntries(components.map((c) => [c.component, c]));
        expect(by.rspamd).toMatchObject({ status: "running", version: "4.1.5" });
        expect(by.redis).toMatchObject({ status: "not-ready", version: "8" });
        expect(by.redis.pods).toHaveLength(2);
        expect(by.clamav).toMatchObject({ status: "missing", pods: [] });
        expect(by.clamav.version).toBeUndefined();
    });

    it("prefers a ready pod's version", () => {
        const components = buildComponents([
            classifyPod(pod("redis-0", "redis", "bitnami/redis:7", { ready: false })),
            classifyPod(pod("redis-1", "redis", "bitnami/redis:8")),
        ]);
        expect(components.find((c) => c.component === "redis")).toMatchObject({ status: "running", version: "8" });
    });
});

describe("distributionOf", () => {
    it.each([
        ["v1.31.4+k3s1", "k3s"],
        ["v1.31.4+rke2r1", "rke2"],
        ["v1.31.4-eks-abc", "eks"],
        ["v1.31.4-gke.1000", "gke"],
        ["v1.31.4-aks", "aks"],
        ["v1.31.4", "kubernetes"],
    ])("%s is %s", (gitVersion, expected) => {
        expect(distributionOf(gitVersion)).toBe(expected);
    });
});

describe("nodesOf", () => {
    it("groups the pods by the node they run on", () => {
        const nodes = nodesOf([
            classifyPod(pod("a", "redis", "bitnami/redis:8", { node: "n2", hostIP: "10.0.0.2" })),
            classifyPod(pod("b", "rspamd", "rspamd/rspamd:1", { node: "n1", hostIP: "10.0.0.1" })),
            classifyPod(pod("c", "clamav", "clamav/clamav:1", { node: "n2", hostIP: "10.0.0.2" })),
            classifyPod({ metadata: { name: "pending" } }),
        ]);
        expect(nodes).toEqual([
            { name: "n1", internalIP: "10.0.0.1", podCount: 1 },
            { name: "n2", internalIP: "10.0.0.2", podCount: 2 },
        ]);
    });

    it("fills a missing address from a later pod", () => {
        const first = classifyPod(pod("a", "redis", "bitnami/redis:8", { node: "n1" }));
        first.hostIP = undefined;
        expect(nodesOf([first, classifyPod(pod("b", "rspamd", "rspamd/rspamd:1", { node: "n1", hostIP: "10.9.9.9" }))])[0].internalIP).toBe("10.9.9.9");
    });
});

describe("listPods and collectRuntime", () => {
    const client = (responses: Record<string, any>) =>
        ({
            get: vi.fn(async (path: string) => {
                if (path in responses) {
                    const value = responses[path];
                    if (value instanceof Error) throw value;
                    return value;
                }
                throw new Error(`unexpected ${path}`);
            }),
        }) as any;

    it("lists a namespace's pods", async () => {
        const c = client({ "/api/v1/namespaces/mail/pods": { items: [pod("a", "redis", "bitnami/redis:8")] } });
        expect((await listPods(c, "mail")).map((p) => p.pod.name)).toEqual(["a"]);
        const empty = client({ "/api/v1/namespaces/mail/pods": {} });
        expect(await listPods(empty, "mail")).toEqual([]);
    });

    it("says why there is no client", async () => {
        expect(await collectRuntime(undefined, "not in a cluster", "")).toEqual({ available: false, reason: "not in a cluster", nodes: [] });
    });

    it("reports the version and the nodes the pods run on", async () => {
        const c = client({
            "/version": { gitVersion: "v1.31.4+k3s1", major: "1", minor: "31", platform: "linux/amd64", goVersion: "go1.23", buildDate: "2026-01-01" },
            "/api/v1/namespaces/mail/pods": { items: [pod("a", "redis", "bitnami/redis:8")] },
        });
        expect(await collectRuntime(c, undefined, "mail")).toEqual({
            available: true,
            namespace: "mail",
            version: {
                gitVersion: "v1.31.4+k3s1", major: "1", minor: "31", platform: "linux/amd64", goVersion: "go1.23", buildDate: "2026-01-01", distribution: "k3s",
            },
            nodes: [{ name: "node-1", internalIP: "10.0.0.5", podCount: 1 }],
        });
    });

    it("still reports the version when the pods can't be listed, and fills blanks", async () => {
        const c = client({ "/version": {}, "/api/v1/namespaces/mail/pods": new Error("forbidden") });
        expect(await collectRuntime(c, undefined, "mail")).toMatchObject({
            available: true,
            version: { gitVersion: "", distribution: "kubernetes" },
            nodes: [],
        });
    });

    it("reports a failed version request", async () => {
        const c = client({ "/version": new Error("HTTP 500") });
        expect(await collectRuntime(c, undefined, "mail")).toEqual({ available: false, reason: "HTTP 500", namespace: "mail", nodes: [] });
    });

    it("formats errors", () => {
        expect(errorMessage(new Error("x"))).toBe("x");
        expect(errorMessage("y")).toBe("y");
    });
});
