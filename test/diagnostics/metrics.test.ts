///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
import os from "node:os";
import path from "node:path";
import { classifyPod, type KubePod } from "../../src/diagnostics/kubernetesInfo.js";
import { KubeError } from "../../src/diagnostics/KubeClient.js";
import { collectKubernetesMetrics, parseBalloon, parsePressure, ProcessSampler, readCgroupMemoryUsage, readProcFile, serverMounts, sharesNodeDisk } from "../../src/diagnostics/metrics.js";
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

describe("readProcFile", () => {
    // Whether the kernel's files exist depends on the platform (there are none on Windows, and every one is there on most Linux
    // hosts), so both answers are made here, from a file that is there and one that is not.
    it("reads a file, and says nothing for one that is missing", async () => {
        const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
        const dir = await mkdtemp(path.join(os.tmpdir(), "proc-"));
        try {
            await writeFile(path.join(dir, "vmstat"), "balloon_inflate 1\n");
            expect(readProcFile(path.join(dir, "vmstat"))).toBe("balloon_inflate 1\n");
            expect(readProcFile(path.join(dir, "missing"))).toBeUndefined();
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});

describe("parseBalloon", () => {
    // /proc/vmstat of a guest whose hypervisor's balloon has been taking and giving back memory.
    const vmstat = ["pgfault 100", "balloon_inflate 160613120", "balloon_deflate 158575616", "balloon_migrate 13714"].join("\n");

    it("says how much the balloon holds now, and how much it has taken since boot", () => {
        expect(parseBalloon(vmstat)).toEqual({ heldBytes: (160613120 - 158575616) * 4096, inflatedTotalBytes: 160613120 * 4096 });
    });

    it("says nothing where the balloon has never taken anything, or the kernel has no counters", () => {
        expect(parseBalloon("balloon_inflate 0\nballoon_deflate 0")).toBeUndefined();
        expect(parseBalloon("pgfault 1\nballoon_inflate 5")).toBeUndefined();
        expect(parseBalloon("pgfault 1")).toBeUndefined();
        expect(parseBalloon(undefined)).toBeUndefined();
    });

    it("never reports a negative amount", () => {
        expect(parseBalloon("balloon_inflate 10\nballoon_deflate 12")?.heldBytes).toBe(0);
    });
});

describe("parsePressure", () => {
    it("reads the some and full lines", () => {
        const text = "some avg10=64.35 avg60=73.93 avg300=33.85 total=2451917491\nfull avg10=45.64 avg60=55.43 avg300=25.77 total=1812084336\n";
        expect(parsePressure(text)).toEqual({
            some: { avg10: 64.35, avg60: 73.93, avg300: 33.85 },
            full: { avg10: 45.64, avg60: 55.43, avg300: 25.77 },
        });
    });

    it("reads a file with only a some line, as the CPU one has", () => {
        expect(parsePressure("some avg10=1.00 avg60=2.00 avg300=3.00 total=4\r\n")).toEqual({ some: { avg10: 1, avg60: 2, avg300: 3 }, full: undefined });
    });

    it("says nothing for a missing file or one it cannot read", () => {
        expect(parsePressure(undefined)).toBeUndefined();
        expect(parsePressure("")).toBeUndefined();
        expect(parsePressure("some avg10=x avg60=1 avg300=1 total=1")).toBeUndefined();
        expect(parsePressure("full avg10=1.00 avg60=1.00 avg300=1.00 total=1")).toBeUndefined();
    });
});

describe("ProcessSampler", () => {
    it("reads the balloon and the pressure from the kernel's files, and omits what it does not have", async () => {
        const files: Record<string, string | undefined> = {
            "/proc/vmstat": "balloon_inflate 300\nballoon_deflate 100",
            "/proc/pressure/memory": "some avg10=5.00 avg60=4.00 avg300=3.00 total=1\nfull avg10=2.00 avg60=1.00 avg300=0.50 total=1",
            "/proc/pressure/io": undefined,
            "/proc/pressure/cpu": "some avg10=9.00 avg60=8.00 avg300=7.00 total=1",
        };
        const read = vi.fn((file: string) => files[file]);
        const host = await new ProcessSampler(() => undefined, (async () => ({ bsize: 1, blocks: 1, bfree: 0, bavail: 0 })), read).host([], 1);
        expect(host.balloon).toEqual({ heldBytes: 200 * 4096, inflatedTotalBytes: 300 * 4096 });
        expect(host.pressure).toEqual({
            memory: { some: { avg10: 5, avg60: 4, avg300: 3 }, full: { avg10: 2, avg60: 1, avg300: 0.5 } },
            io: undefined,
            cpu: { some: { avg10: 9, avg60: 8, avg300: 7 }, full: undefined },
        });

        const bare = await new ProcessSampler(() => undefined, (async () => ({ bsize: 1, blocks: 1, bfree: 0, bavail: 0 })), () => undefined).host([], 1);
        expect(bare.balloon).toBeUndefined();
        expect(bare.pressure).toBeUndefined();
    });

    it("reads the real kernel files where there are some, and none where there are not", async () => {
        const host = await new ProcessSampler().host([]);
        expect(host.balloon === undefined || host.balloon.heldBytes >= 0).toBe(true);
        expect(host.pressure === undefined || typeof host.pressure === "object").toBe(true);
    });

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
        const sizeDirectory = vi.fn(async () => ({ bytes: 3 * GiB, partial: false }));
        const result = await collectKubernetesMetrics(client({ [PODS]: podMetrics, [PVCS]: pvcs }), "mail", "srv-1", pods, mounted, sizeDirectory);
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
            // What the volume's directory holds, not the 40 GiB the node's disk it is on has in use.
            usedBytes: 3 * GiB,
            measuredBy: "directory",
            availableBytes: 160 * GiB,
            mountedByServer: true,
            sharesNodeDisk: true,
        });
        expect(sizeDirectory).toHaveBeenCalledWith("/data");
        const unmounted = result.pvcs.find((p) => p.name === "redis-data")!;
        expect(unmounted).toMatchObject({ mountedByServer: false, sharesNodeDisk: undefined });
        expect(unmounted.usedBytes).toBeUndefined();
        expect(result.pvcs[0]).toMatchObject({ phase: "Unknown" });
    });

    it("reports a partial directory measurement as a lower bound", async () => {
        const result = await collectKubernetesMetrics(client({ [PODS]: podMetrics, [PVCS]: pvcs }), "mail", "srv-1", pods, mounted, async () => ({
            bytes: GiB,
            partial: true,
        }));
        expect(result.pvcs.find((p) => p.name === "blob-data")).toMatchObject({ usedBytes: GiB, measuredBy: "directory", usedPartial: true });
    });

    it("gives a volume on the node's disk no usage when its directory cannot be measured, rather than the disk's", async () => {
        for (const sizeDirectory of [async () => undefined, undefined]) {
            const result = await collectKubernetesMetrics(client({ [PODS]: podMetrics, [PVCS]: pvcs }), "mail", "srv-1", pods, mounted, sizeDirectory);
            const blob = result.pvcs.find((p) => p.name === "blob-data")!;
            expect(blob).toMatchObject({ mountedByServer: true, sharesNodeDisk: true, availableBytes: 160 * GiB });
            expect(blob.usedBytes).toBeUndefined();
            expect(blob.measuredBy).toBeUndefined();
        }
    });

    it("takes the usage of a volume with a filesystem of its own from that filesystem, without walking anything", async () => {
        const own = new Map<string, DiagnosticsDiskMetrics>([
            ["blob-data", { path: "/data", pvc: "blob-data", usedBytes: 4 * GiB, capacityBytes: 10 * GiB, availableBytes: 6 * GiB }],
        ]);
        const sizeDirectory = vi.fn(async () => ({ bytes: 1, partial: false }));
        const result = await collectKubernetesMetrics(client({ [PODS]: podMetrics, [PVCS]: pvcs }), "mail", "srv-1", pods, own, sizeDirectory);
        expect(result.pvcs.find((p) => p.name === "blob-data")).toMatchObject({ usedBytes: 4 * GiB, measuredBy: "filesystem", sharesNodeDisk: undefined });
        expect(sizeDirectory).not.toHaveBeenCalled();
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
