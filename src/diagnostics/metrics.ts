///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
import { readFileSync } from "node:fs";
import { statfs } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { errorMessage, type ClassifiedPod } from "./kubernetesInfo.js";
import { KubeError, type KubeClient } from "./KubeClient.js";
import { parseQuantity } from "./quantity.js";
import type {
    DiagnosticsDiskMetrics,
    DiagnosticsHostMetrics,
    DiagnosticsMetrics,
    DiagnosticsPodMetrics,
    DiagnosticsProcessMetrics,
    DiagnosticsPvcMetrics,
} from "./types.js";

/** Two samples closer than this reuse the last CPU figure: a rate over a few milliseconds is noise. */
const MIN_CPU_WINDOW_MS = 250;

/** A volume is "much bigger than what it backs" beyond this: a real volume's filesystem is within its overhead of its size. */
const SHARED_DISK_TOLERANCE = 0.1;

export type StatFs = (path: string) => Promise<{ bsize: number; blocks: number; bfree: number; bavail: number }>;

/** The container's own memory use, when the cgroup says (v2, then v1); undefined elsewhere (Windows, macOS). */
export function readCgroupMemoryUsage(): number | undefined {
    for (const file of ["/sys/fs/cgroup/memory.current", "/sys/fs/cgroup/memory/memory.usage_in_bytes"]) {
        try {
            const value = Number(readFileSync(file, "utf8").trim());
            if (Number.isFinite(value)) {
                return value;
            }
        } catch {
            // Try the next layout.
        }
    }
    return undefined;
}

/** Sums of the host's CPU times across all cores: what a busy percentage is worked out from. */
function cpuTimes(): { busy: number; total: number } {
    let busy = 0;
    let total = 0;
    for (const { times } of os.cpus()) {
        const sum = times.user + times.nice + times.sys + times.idle + times.irq;
        total += sum;
        busy += sum - times.idle;
    }
    return { busy, total };
}

/**
 * Samples this Node.js process and the machine around it. It keeps the previous sample of each to turn CPU time into a rate,
 * so the first sample is an average since the process (or the machine) started.
 */
export class ProcessSampler {
    private lastProcess?: { cpu: NodeJS.CpuUsage; at: number; percent: number };
    private lastHost?: { busy: number; total: number; at: number; percent: number };

    constructor(
        private readonly readCgroup: () => number | undefined = readCgroupMemoryUsage,
        private readonly stat: StatFs = statfs
    ) {}

    sample(now: number = Date.now()): DiagnosticsProcessMetrics {
        const cpu = process.cpuUsage();
        let percent: number;
        if (this.lastProcess && now - this.lastProcess.at < MIN_CPU_WINDOW_MS) {
            percent = this.lastProcess.percent;
        } else {
            const elapsedMicros = this.lastProcess ? (now - this.lastProcess.at) * 1000 : process.uptime() * 1e6;
            const usedMicros = this.lastProcess
                ? cpu.user + cpu.system - (this.lastProcess.cpu.user + this.lastProcess.cpu.system)
                : cpu.user + cpu.system;
            percent = elapsedMicros > 0 ? Math.max(0, (usedMicros / elapsedMicros) * 100) : 0;
            this.lastProcess = { cpu, at: now, percent };
        }
        const memory = process.memoryUsage();
        const limit = (process as any).constrainedMemory?.() as number | undefined;
        const constrained = typeof limit === "number" && limit > 0 && limit < os.totalmem();
        const cgroupUsage = constrained ? this.readCgroup() : undefined;
        const [one, five, fifteen] = os.loadavg();
        return {
            cpuPercent: Math.round(percent * 10) / 10,
            rssBytes: memory.rss,
            heapUsedBytes: memory.heapUsed,
            heapTotalBytes: memory.heapTotal,
            loadAverage: [one, five, fifteen],
            systemMemoryTotalBytes: constrained ? limit : os.totalmem(),
            systemMemoryFreeBytes: constrained ? Math.max(0, limit - (cgroupUsage ?? memory.rss)) : os.freemem(),
            cpuCount: os.availableParallelism(),
        };
    }

    /**
     * The machine's CPU and memory, and the disks behind `mounts` (paths in this container) plus its root filesystem. Inside a
     * container these are the node's: `os` reports the host, and a hostPath-style volume is a directory of the host's disk.
     */
    async host(mounts: { path: string; pvc?: string }[], now: number = Date.now()): Promise<DiagnosticsHostMetrics> {
        const times = cpuTimes();
        let percent: number;
        if (this.lastHost && now - this.lastHost.at < MIN_CPU_WINDOW_MS) {
            percent = this.lastHost.percent;
        } else {
            const busy = times.busy - (this.lastHost?.busy ?? 0);
            const total = times.total - (this.lastHost?.total ?? 0);
            percent = total > 0 ? Math.min(100, Math.max(0, (busy / total) * 100)) : 0;
            this.lastHost = { ...times, at: now, percent };
        }
        const root = path.parse(process.cwd()).root;
        const disks: DiagnosticsDiskMetrics[] = [];
        for (const mount of [{ path: root }, ...mounts]) {
            try {
                const stats = await this.stat(mount.path);
                disks.push({
                    path: mount.path,
                    pvc: (mount as { pvc?: string }).pvc,
                    capacityBytes: stats.blocks * stats.bsize,
                    usedBytes: (stats.blocks - stats.bfree) * stats.bsize,
                    availableBytes: stats.bavail * stats.bsize,
                });
            } catch {
                // A path that can't be read is left out rather than failing the whole sample.
            }
        }
        const [one, five, fifteen] = os.loadavg();
        return {
            cpuPercent: Math.round(percent * 10) / 10,
            cpuCount: os.availableParallelism(),
            memoryTotalBytes: os.totalmem(),
            memoryUsedBytes: os.totalmem() - os.freemem(),
            loadAverage: [one, five, fifteen],
            disks,
        };
    }
}

/** What a PVC's requested or provisioned size is, in bytes. */
function pvcSize(pvc: any): number | undefined {
    return parseQuantity(pvc.status?.capacity?.storage) ?? parseQuantity(pvc.spec?.resources?.requests?.storage);
}

/** Whether a filesystem of `filesystemBytes` is far bigger than the `volumeBytes` volume it backs. */
export function sharesNodeDisk(filesystemBytes: number, volumeBytes: number | undefined): boolean | undefined {
    if (!volumeBytes) {
        return undefined;
    }
    return Math.abs(filesystemBytes - volumeBytes) / volumeBytes > SHARED_DISK_TOLERANCE ? true : undefined;
}

/** The mounts of the PVCs the server pod itself holds - the only volumes whose usage it can measure. */
export function serverMounts(pods: ClassifiedPod[], hostname: string): { path: string; pvc: string }[] {
    const own = pods.find((p) => p.pod.name === hostname);
    return (own?.claims ?? []).map((c) => ({ path: c.mountPath, pvc: c.claimName }));
}

/** Which component each pod of the namespace is, with this server's own pod (and its replicas, by `app` label) as `server`. */
function podComponents(pods: ClassifiedPod[], hostname: string): Map<string, DiagnosticsPodMetrics["component"]> {
    const own = pods.find((p) => p.pod.name === hostname);
    const serverApp = own?.labels.app;
    return new Map(
        pods.map((p) => [
            p.pod.name,
            p.component ?? (serverApp !== undefined && p.labels.app === serverApp ? ("server" as const) : undefined),
        ])
    );
}

/** Each pod's CPU (cores) and memory (bytes) from metrics-server, summed over its containers. */
async function podUsage(client: KubeClient, namespace: string): Promise<Map<string, { cpu: number; memory: number }>> {
    const list = await client.get<{ items?: any[] }>(
        `/apis/metrics.k8s.io/v1beta1/namespaces/${encodeURIComponent(namespace)}/pods`
    );
    const usage = new Map<string, { cpu: number; memory: number }>();
    for (const item of list.items ?? []) {
        let cpu = 0;
        let memory = 0;
        for (const container of item.containers ?? []) {
            cpu += parseQuantity(container.usage?.cpu) ?? 0;
            memory += parseQuantity(container.usage?.memory) ?? 0;
        }
        usage.set(item.metadata?.name, { cpu, memory });
    }
    return usage;
}

function podMetricsReason(err: unknown): string {
    if (err instanceof KubeError && err.status === 404) {
        return "metrics-server is not installed in this cluster (k3s includes it by default), so per-pod CPU and memory are not available.";
    }
    return `Per-pod CPU and memory could not be read: ${errorMessage(err)}`;
}

/**
 * The Kubernetes side of the System view, all inside the server's own namespace (a Role, no cluster access): the namespace's pods
 * with metrics-server's CPU and memory when it is installed, and its PVCs with their size - and their usage for the ones the
 * server pod has mounted, measured by the caller from inside the container (`ProcessSampler.host`).
 */
export async function collectKubernetesMetrics(
    client: KubeClient,
    namespace: string,
    hostname: string,
    classified: ClassifiedPod[],
    mountedUsage: Map<string, DiagnosticsDiskMetrics>
): Promise<DiagnosticsMetrics["kubernetes"]> {
    const errors: string[] = [];

    const [usage, claims] = await Promise.all([
        podUsage(client, namespace).then(
            (value) => ({ value }),
            (err) => ({ reason: podMetricsReason(err) })
        ),
        client
            .get<{ items?: any[] }>(`/api/v1/namespaces/${encodeURIComponent(namespace)}/persistentvolumeclaims`)
            .then((list) => list.items ?? [])
            .catch((err) => {
                errors.push(`Could not list the persistent volume claims: ${errorMessage(err)}`);
                return [] as any[];
            }),
    ]);

    const componentOf = podComponents(classified, hostname);
    const podList: DiagnosticsPodMetrics[] = classified
        .map((p) => {
            const used = "value" in usage ? usage.value.get(p.pod.name) : undefined;
            return { name: p.pod.name, component: componentOf.get(p.pod.name), cpuUsedCores: used?.cpu, memoryUsedBytes: used?.memory };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
    const measured = podList.filter((p) => p.cpuUsedCores !== undefined);

    return {
        available: true,
        namespace: {
            name: namespace,
            podMetricsAvailable: "value" in usage,
            podMetricsReason: "reason" in usage ? usage.reason : undefined,
            cpuUsedCores: "value" in usage ? measured.reduce((sum, p) => sum + (p.cpuUsedCores ?? 0), 0) : undefined,
            memoryUsedBytes: "value" in usage ? measured.reduce((sum, p) => sum + (p.memoryUsedBytes ?? 0), 0) : undefined,
            pods: podList,
        },
        pvcs: claims
            .map((pvc): DiagnosticsPvcMetrics => {
                const name: string = pvc.metadata?.name ?? "";
                const size = pvcSize(pvc);
                const disk = mountedUsage.get(name);
                return {
                    name,
                    phase: pvc.status?.phase ?? "Unknown",
                    storageClass: pvc.spec?.storageClassName,
                    requestedBytes: parseQuantity(pvc.spec?.resources?.requests?.storage),
                    capacityBytes: size,
                    usedBytes: disk?.usedBytes,
                    availableBytes: disk?.availableBytes,
                    mountedByServer: disk !== undefined,
                    sharesNodeDisk: disk ? sharesNodeDisk(disk.capacityBytes, size) : undefined,
                };
            })
            .sort((a, b) => a.name.localeCompare(b.name)),
        errors,
    };
}
