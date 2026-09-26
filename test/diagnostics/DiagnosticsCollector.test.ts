///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DiagnosticsCollector } from "../../src/diagnostics/DiagnosticsCollector.js";
import type { KubeRequest } from "../../src/diagnostics/KubeClient.js";

const digest = `sha256:${"c".repeat(64)}`;

describe("DiagnosticsCollector", () => {
    let root: string;
    let saDir: string;

    beforeEach(async () => {
        root = await mkdtemp(path.join(os.tmpdir(), "diag-"));
        saDir = path.join(root, "sa");
        await mkdir(saDir);
        await writeFile(path.join(saDir, "token"), "tok");
        await writeFile(path.join(saDir, "namespace"), "mail");
        await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "server", version: "9.9.9", dependencies: { dep: "1" } }));
        await mkdir(path.join(root, "node_modules", "dep"), { recursive: true });
        await writeFile(path.join(root, "node_modules", "dep", "package.json"), JSON.stringify({ name: "dep", version: "1.0.0" }));
    });

    afterEach(async () => {
        await rm(root, { recursive: true, force: true });
    });

    const inCluster = { KUBERNETES_SERVICE_HOST: "10.0.0.1" };

    function transportFor(routes: Record<string, any>) {
        return vi.fn(async (request: KubeRequest) => {
            const value = routes[request.url.pathname];
            if (value === undefined) return { status: 404, body: "{}" };
            if (typeof value === "number") return { status: value, body: "{}" };
            return { status: 200, body: JSON.stringify(value) };
        });
    }

    const redisPod = {
        metadata: { name: "redis-0", labels: { app: "redis" } },
        spec: { nodeName: "n1", containers: [{ name: "redis", image: "bitnami/redis:8" }] },
        status: { phase: "Running", hostIP: "10.0.0.9", containerStatuses: [{ name: "redis", ready: true, restartCount: 0, imageID: `x@${digest}` }] },
    };
    const serverPod = {
        metadata: { name: "srv-1", labels: { app: "srv" } },
        spec: {
            nodeName: "n1",
            containers: [{ name: "server", image: "ghcr.io/rapidmx/server:9", volumeMounts: [{ name: "blob", mountPath: "/" }] }],
            volumes: [{ name: "blob", persistentVolumeClaim: { claimName: "blob-data" } }],
        },
        status: { phase: "Running", hostIP: "10.0.0.9", containerStatuses: [{ name: "server", ready: true, restartCount: 1 }] },
    };

    function collector(env: NodeJS.ProcessEnv, transport?: any, extra: object = {}) {
        return new DiagnosticsCollector({
            root, env, serviceAccountDir: saDir, transport, hostname: () => "srv-1", now: () => new Date("2026-09-26T12:00:00Z"), ...extra,
        });
    }

    describe("outside Kubernetes", () => {
        it("answers the server's own details and says Kubernetes is unavailable", async () => {
            const c = collector({});
            const versions = await c.versions();
            expect(versions.server).toMatchObject({ packageName: "server", packageVersion: "9.9.9", nodeVersion: process.version });
            expect(versions.packages).toEqual([{ name: "dep", version: "1.0.0", direct: true }]);
            expect(versions.kubernetes).toMatchObject({ available: false });
            expect(versions.kubernetes.reason).toMatch(/not running in Kubernetes/);
            expect(versions.components).toHaveLength(8);
            expect(versions.components.every((x) => x.status === "unknown")).toBe(true);

            expect(await c.runtime()).toMatchObject({ available: false, nodes: [] });

            const metrics = await c.metrics();
            expect(metrics.collectedAt).toBe("2026-09-26T12:00:00.000Z");
            expect(metrics.process.rssBytes).toBeGreaterThan(0);
            expect(metrics.host.disks.length).toBeGreaterThan(0);
            expect(metrics.kubernetes).toMatchObject({ available: false, pvcs: [], errors: [] });
        });

        it("reuses the package listing for a minute, then reads it again", async () => {
            let now = new Date("2026-09-26T12:00:00Z");
            const c = collector({}, undefined, { now: () => now });
            expect((await c.versions()).packages).toHaveLength(1);
            await mkdir(path.join(root, "node_modules", "later"));
            await writeFile(path.join(root, "node_modules", "later", "package.json"), JSON.stringify({ name: "later", version: "2.0.0" }));
            expect((await c.versions()).packages).toHaveLength(1);
            now = new Date("2026-09-26T12:02:00Z");
            expect((await c.versions()).packages).toHaveLength(2);
        });

        it("has defaults for the working directory, clock and hostname", async () => {
            const c = new DiagnosticsCollector({ env: {} });
            expect((await c.metrics()).collectedAt).toMatch(/^\d{4}-/);
            expect((await c.runtime()).available).toBe(false);
        });
    });

    describe("in a cluster", () => {
        const routes = {
            "/version": { gitVersion: "v1.31.4+k3s1", major: "1", minor: "31", platform: "linux/amd64" },
            "/api/v1/namespaces/mail/pods": { items: [redisPod, serverPod] },
            "/apis/metrics.k8s.io/v1beta1/namespaces/mail/pods": { items: [{ metadata: { name: "redis-0" }, containers: [{ usage: { cpu: "5m", memory: "10Mi" } }] }] },
            "/api/v1/namespaces/mail/persistentvolumeclaims": {
                items: [{ metadata: { name: "blob-data" }, status: { phase: "Bound", capacity: { storage: "1Ki" } }, spec: { resources: { requests: { storage: "1Ki" } } } }],
            },
        };

        it("reports the components, the runtime and the metrics from the namespace", async () => {
            const transport = transportFor(routes);
            const c = collector(inCluster, transport);

            const versions = await c.versions();
            expect(versions.kubernetes).toEqual({ available: true });
            expect(versions.components.find((x) => x.component === "redis")).toMatchObject({ status: "running", version: "8" });
            expect(versions.components.find((x) => x.component === "clamav")!.status).toBe("missing");

            expect(await c.runtime()).toMatchObject({
                available: true, namespace: "mail", version: { distribution: "k3s" }, nodes: [{ name: "n1", internalIP: "10.0.0.9", podCount: 2 }],
            });

            const metrics = await c.metrics();
            expect(metrics.kubernetes.available).toBe(true);
            expect(metrics.kubernetes.namespace!.pods.map((p) => p.component)).toEqual(["redis", "server"]);
            const pvc = metrics.kubernetes.pvcs[0];
            expect(pvc).toMatchObject({ name: "blob-data", mountedByServer: true });
            expect(metrics.host.disks.find((d) => d.pvc === "blob-data")!.sharesNodeDisk).toBe(pvc.sharesNodeDisk);
            // Nothing outside the namespace and no node was ever asked about.
            const asked = transport.mock.calls.map(([r]) => r.url.pathname);
            expect(asked.every((p) => p === "/version" || p.includes("/namespaces/mail/"))).toBe(true);
            expect(asked.some((p) => p.includes("/nodes"))).toBe(false);
        });

        it("uses a configured namespace instead of the pod's own", async () => {
            const transport = transportFor({ "/api/v1/namespaces/other/pods": { items: [] } });
            const versions = await collector(inCluster, transport, { namespace: "other" }).versions();
            expect(versions.kubernetes.available).toBe(true);
            expect(transport.mock.calls[0][0].url.pathname).toBe("/api/v1/namespaces/other/pods");
        });

        it("reports that the server may not list pods, on every question", async () => {
            const c = collector(inCluster, transportFor({ "/version": routes["/version"], "/api/v1/namespaces/mail/pods": 403 }));
            const versions = await c.versions();
            expect(versions.kubernetes.available).toBe(false);
            expect(versions.kubernetes.reason).toMatch(/HTTP 403/);
            expect(versions.components.every((x) => x.status === "unknown")).toBe(true);
            expect(await c.runtime()).toMatchObject({ available: true, nodes: [] });
            const metrics = await c.metrics();
            expect(metrics.kubernetes).toMatchObject({ available: false });
            expect(metrics.kubernetes.reason).toMatch(/Could not list the pods: .*HTTP 403/);
            expect(metrics.host.cpuCount).toBeGreaterThan(0);
        });

        it("reports a missing namespace file and a failed version request", async () => {
            await rm(path.join(saDir, "namespace"));
            const c = collector(inCluster, transportFor(routes));
            expect((await c.versions()).kubernetes.available).toBe(false);
            expect(await c.runtime()).toMatchObject({ available: false, nodes: [] });
            expect((await c.metrics()).kubernetes.available).toBe(false);

            await writeFile(path.join(saDir, "namespace"), "mail");
            const noVersion = collector(inCluster, transportFor({ "/api/v1/namespaces/mail/pods": { items: [] } }));
            expect(await noVersion.runtime()).toMatchObject({ available: false, namespace: "mail" });
        });
    });
});
