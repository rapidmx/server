///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
import os from "node:os";
import { classifyPod, type KubePod } from "../../src/diagnostics/kubernetesInfo.js";
import { KubeError } from "../../src/diagnostics/KubeClient.js";
import { collectKubernetesMetrics, ProcessSampler, readCgroupMemoryUsage, serverMounts, sharesNodeDisk } from "../../src/diagnostics/metrics.js";
import type { DiagnosticsDiskMetrics } from "../../src/diagnostics/types.js";

function pod(name: string, container: string, image: string, app: string, claims: [string, string][] = []): KubePod {
    return {
        metadata: { name, labels: { app } },
        spec: {
            containers: [{ name: container, image, volumeMounts: claims.map(([claim, mountPath]) => ({ name: claim, mountPath })) }],
            volumes: claims.map(([claim]) => ({ name: claim, persistentVolumeClaim: { claimName: claim } })),
        },
    };
}

const GiB = 1024 ** 3;

describe("sharesNodeDisk", () => {
    it("flags a filesystem far bigger than the volume it backs", () => {
        expect(sharesNodeDisk(100 * GiB, 10 * GiB)).toBe(true);
        expect(sharesNodeDisk(9.7 * GiB, 10 * GiB)).toBeUndefined();
        expect(sharesNodeDisk(9.7 * GiB, undefined)).toBeUndefined();
    });
});

describe("serverMounts", () => {
    it("lists the PVCs the server pod itself mounts", () => {
        const pods = [classifyPod(pod("srv-1", "server", "ghcr.io/rapidmx/server:1", "srv", [["blob-data", "/data/blobs"]])), classifyPod(pod("other", "redis", "redis:8", "redis"))];
        expect(serverMounts(pods, "srv-1")).toEqual([{ path: "/data/blobs", pvc: "blob-data" }]);
        expect(serverMounts(pods, "not-a-pod")).toEqual([]);
    });
});

describe("readCgroupMemoryUsage", () => {
    it("returns a number or nothing, never throws", () => {
        const value = readCgroupMemoryUsage();
        expect(value === undefined || Number.isFinite(value)).toBe(true);
    });
});

describe("ProcessSampler", () => {
    it("samples the process and turns CPU time into a rate", () => {
        const sampler = new ProcessSampler(() => undefined);
        const first = sampler.sample(1_000_000);
        expect(first.rssBytes).toBeGreaterThan(0);
        expect(first.heapUsedBytes).toBeLessThanOrEqual(first.heapTotalBytes);
        expect(first.cpuCount).toBeGreaterThan(0);
        expect(first.loadAverage).toHaveLength(3);
        expect(first.systemMemoryTotalBytes).toBeGreaterThan(0);
        expect(first.cpuPercent).toBeGreaterThanOrEqual(0);

        // Too soon after the last one: the same figure again.
        expect(sampler.sample(1_000_100).cpuPercent).toBe(first.cpuPercent);

        // Burn a little CPU, then sample after a real window.
        const until = Date.now() + 30;
        while (Date.now() < until) { /* spin */ }
        expect(sampler.sample(1_005_000).cpuPercent).toBeGreaterThan(0);
    });

    it("uses the container's memory limit when it has one", () => {
        const limit = Math.floor(os.totalmem() / 2);
        const original = (process as any).constrainedMemory;
        (process as any).constrainedMemory = () => limit;
        try {
            const sample = new ProcessSampler(() => limit - 1000).sample();
            expect(sample.systemMemoryTotalBytes).toBe(limit);
            expect(sample.systemMemoryFreeBytes).toBe(1000);
            expect(new ProcessSampler(() => undefined).sample().systemMemoryFreeBytes).toBeGreaterThanOrEqual(0);
        } finally {
            (process as any).constrainedMemory = original;
        }
    });

    it("measures the host and the disks it is asked about, skipping unreadable paths", async () => {
        const stat = vi.fn(async (path: string) => {
            if (path === "/missing") throw new Error("ENOENT");
            return { bsize: 4096, blocks: 1000, bfree: 400, bavail: 300 };
        });
        const sampler = new ProcessSampler(() => undefined, stat as any);
        const host = await sampler.host([{ path: "/data", pvc: "blob-data" }, { path: "/missing" }], 5_000_000);
        expect(host.cpuCount).toBeGreaterThan(0);
        expect(host.memoryTotalBytes).toBeGreaterThan(host.memoryUsedBytes);
        expect(host.cpuPercent).toBeGreaterThanOrEqual(0);
        expect(host.cpuPercent).toBeLessThanOrEqual(100);
        expect(host.disks).toHaveLength(2);
        expect(host.disks[1]).toEqual({
            path: "/data", pvc: "blob-data", capacityBytes: 4096 * 1000, usedBytes: 4096 * 600, availableBytes: 4096 * 300,
        });
        // A second sample straight away reuses the CPU figure; a later one recomputes it.
        expect((await sampler.host([], 5_000_100)).cpuPercent).toBe(host.cpuPercent);
        expect((await sampler.host([], 5_010_000)).cpuPercent).toBeGreaterThanOrEqual(0);
    });
});

describe("collectKubernetesMetrics", () => {
    const pods = [
        classifyPod(pod("srv-1", "server", "ghcr.io/rapidmx/server:1", "srv", [["blob-data", "/data"]])),
        classifyPod(pod("srv-2", "server", "ghcr.io/rapidmx/server:1", "srv")),
        classifyPod(pod("redis-0", "redis", "bitnami/redis:8", "redis")),
        classifyPod(pod("job-1", "job", "busybox", "job")),
    ];
    const pvcs = {
        items: [
            { metadata: { name: "redis-data" }, status: { phase: "Bound", capacity: { storage: "8Gi" } }, spec: { storageClassName: "local-path", resources: { requests: { storage: "8Gi" } } } },
            { metadata: { name: "blob-data" }, status: { phase: "Bound", capacity: { storage: "10Gi" } }, spec: { storageClassName: "local-path", resources: { requests: { storage: "5Gi" } } } },
            { spec: {} },
        ],
    };
    const podMetrics = {
        items: [
            { metadata: { name: "srv-1" }, containers: [{ usage: { cpu: "250m", memory: "100Mi" } }, { usage: { cpu: "50m", memory: "20Mi" } }] },
            { metadata: { name: "redis-0" }, containers: [{ usage: { cpu: "10m", memory: "50Mi" } }, {}] },
            { metadata: { name: "srv-2" } },
        ],
    };
    const mounted = new Map<string, DiagnosticsDiskMetrics>([
        ["blob-data", { path: "/data", pvc: "blob-data", usedBytes: 40 * GiB, capacityBytes: 200 * GiB, availableBytes: 160 * GiB }],
    ]);

    const client = (routes: Record<string, any>) =>
        ({
            get: vi.fn(async (path: string) => {
                const value = routes[path];
                if (value instanceof Error) throw value;
                if (value === undefined) throw new Error(`unexpected ${path}`);
                return value;
            }),
        }) as any;

    const PODS = "/apis/metrics.k8s.io/v1beta1/namespaces/mail/pods";
    const PVCS = "/api/v1/namespaces/mail/persistentvolumeclaims";

    it("combines pod metrics, pod components and PVC usage", async () => {
        const result = await collectKubernetesMetrics(client({ [PODS]: podMetrics, [PVCS]: pvcs }), "mail", "srv-1", pods, mounted);
        expect(result.available).toBe(true);
        expect(result.errors).toEqual([]);
        expect(result.namespace).toMatchObject({ name: "mail", podMetricsAvailable: true, podMetricsReason: undefined });
        expect(result.namespace!.cpuUsedCores).toBeCloseTo(0.31);
        expect(result.namespace!.memoryUsedBytes).toBe(170 * 1024 ** 2);
        expect(result.namespace!.pods.map((p) => [p.name, p.component])).toEqual([
            ["job-1", undefined],
            ["redis-0", "redis"],
            ["srv-1", "server"],
            ["srv-2", "server"],
        ]);
        expect(result.namespace!.pods.find((p) => p.name === "job-1")!.cpuUsedCores).toBeUndefined();
        expect(result.pvcs.map((p) => p.name)).toEqual(["", "blob-data", "redis-data"]);
        expect(result.pvcs.find((p) => p.name === "blob-data")).toMatchObject({
            phase: "Bound",
            storageClass: "local-path",
            requestedBytes: 5 * GiB,
            capacityBytes: 10 * GiB,
            usedBytes: 40 * GiB,
            availableBytes: 160 * GiB,
            mountedByServer: true,
            sharesNodeDisk: true,
        });
        expect(result.pvcs.find((p) => p.name === "redis-data")).toMatchObject({ mountedByServer: false, usedBytes: undefined, sharesNodeDisk: undefined });
        expect(result.pvcs[0]).toMatchObject({ phase: "Unknown" });
    });

    it("says metrics-server is missing on a 404 and carries on", async () => {
        const result = await collectKubernetesMetrics(client({ [PODS]: new KubeError("x", 404), [PVCS]: pvcs }), "mail", "srv-1", pods, mounted);
        expect(result.namespace).toMatchObject({ podMetricsAvailable: false, cpuUsedCores: undefined, memoryUsedBytes: undefined });
        expect(result.namespace!.podMetricsReason).toMatch(/metrics-server is not installed/);
        expect(result.namespace!.pods).toHaveLength(4);
    });

    it("reports any other metrics failure, and a failed PVC list, without failing", async () => {
        const result = await collectKubernetesMetrics(client({ [PODS]: new KubeError("HTTP 403", 403), [PVCS]: new Error("boom") }), "mail", "nobody", pods, new Map());
        expect(result.available).toBe(true);
        expect(result.namespace!.podMetricsReason).toMatch(/could not be read: HTTP 403/);
        expect(result.errors).toEqual(["Could not list the persistent volume claims: boom"]);
        expect(result.pvcs).toEqual([]);
        expect(result.namespace!.pods.every((p) => p.component !== "server")).toBe(true);
    });

    it("handles empty lists", async () => {
        const result = await collectKubernetesMetrics(client({ [PODS]: {}, [PVCS]: {} }), "mail", "srv-1", [], new Map());
        expect(result.namespace).toMatchObject({ podMetricsAvailable: true, cpuUsedCores: 0, memoryUsedBytes: 0, pods: [] });
        expect(result.pvcs).toEqual([]);
    });
});
