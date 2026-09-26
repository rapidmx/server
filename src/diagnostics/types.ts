///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////

/**
 * The response shapes of the admin console's Diagnostics page (`GET /api/admin/diagnostics/versions|runtime|metrics`,
 * routes/BaseDiagnosticsRoute.ts). `@rapidmx/web-client`'s `diagnosticsApi.ts` mirrors them.
 */

/** The other containers this deployment runs, in the order the page lists them. */
export const DIAGNOSTICS_COMPONENTS = [
    "postfix",
    "postfix-bridge",
    "mongodb",
    "postgresql",
    "redis",
    "coturn",
    "rspamd",
    "clamav",
] as const;

export type DiagnosticsComponentName = (typeof DIAGNOSTICS_COMPONENTS)[number];

export interface DiagnosticsContainer {
    name: string;
    image: string;
    tag?: string;
    /** `sha256:...` of the image the container is actually running. */
    digest?: string;
    ready: boolean;
    restartCount: number;
}

export interface DiagnosticsPod {
    name: string;
    phase: string;
    ready: boolean;
    restarts: number;
    node?: string;
    startedAt?: string;
    containers: DiagnosticsContainer[];
}

export interface DiagnosticsComponent {
    component: DiagnosticsComponentName;
    /** `missing`: Kubernetes was reachable but no pod for it exists. `unknown`: Kubernetes is not available. */
    status: "running" | "not-ready" | "missing" | "unknown";
    /** The image tag of the component's main container. */
    version?: string;
    pods: DiagnosticsPod[];
}

export interface DiagnosticsServerInfo {
    nodeVersion: string;
    v8Version: string;
    packageName: string;
    packageVersion: string;
    platform: string;
    arch: string;
    hostname: string;
    pid: number;
    startedAt: string;
    uptimeSeconds: number;
    nodeEnv: string;
}

export interface DiagnosticsPackage {
    name: string;
    version: string;
    /** Whether the deployed package.json lists it itself, as opposed to it being pulled in by another package. */
    direct: boolean;
}

export interface DiagnosticsAvailability {
    available: boolean;
    reason?: string;
}

export interface DiagnosticsVersions {
    server: DiagnosticsServerInfo;
    packages: DiagnosticsPackage[];
    components: DiagnosticsComponent[];
    kubernetes: DiagnosticsAvailability;
}

export type KubernetesDistribution = "k3s" | "rke2" | "eks" | "gke" | "aks" | "kubernetes";

/** A node running this namespace's pods. Only what the pods say: nodes are cluster-scoped, which the server's Role can't read. */
export interface DiagnosticsNode {
    name: string;
    internalIP?: string;
    podCount: number;
}

export interface DiagnosticsRuntime extends DiagnosticsAvailability {
    namespace?: string;
    version?: {
        gitVersion: string;
        major: string;
        minor: string;
        platform: string;
        goVersion?: string;
        buildDate?: string;
        distribution: KubernetesDistribution;
    };
    nodes: DiagnosticsNode[];
}

export interface DiagnosticsDiskMetrics {
    /** Where it is mounted in the server's container. */
    path: string;
    /** The PVC mounted there, when it is one. */
    pvc?: string;
    usedBytes: number;
    capacityBytes: number;
    availableBytes: number;
    /**
     * The filesystem is much bigger than the volume it backs (a hostPath-style volume such as k3s's default local-path), so
     * the figures are the node disk's, not the volume's, and the volume's requested size is not enforced.
     */
    sharesNodeDisk?: boolean;
}

/** The node the server pod runs on, as seen from inside its container: on a single-node cluster, the whole machine. */
export interface DiagnosticsHostMetrics {
    /** Whole-host CPU use across all cores, 0-100. */
    cpuPercent: number;
    cpuCount: number;
    memoryTotalBytes: number;
    memoryUsedBytes: number;
    loadAverage: [number, number, number];
    /**
     * Memory the hypervisor holds in the machine's memory balloon. It counts in `memoryUsedBytes` (a guest sees ballooned memory
     * as used) though no process holds it. Absent where no balloon has ever taken memory.
     */
    balloon?: DiagnosticsBalloonMetrics;
    /** How long tasks stall waiting for memory, disk and CPU (Linux pressure stall information). Absent without kernel support. */
    pressure?: DiagnosticsPressureMetrics;
    disks: DiagnosticsDiskMetrics[];
}

export interface DiagnosticsBalloonMetrics {
    /** Taken by the balloon and not given back. */
    heldBytes: number;
    /** Taken since the machine booted, however often it was given back: how much the balloon has been moving. */
    inflatedTotalBytes: number;
}

/** The share (0-100) of the last 10, 60 and 300 seconds that tasks spent stalled. */
export interface DiagnosticsStall {
    avg10: number;
    avg60: number;
    avg300: number;
}

export interface DiagnosticsPressure {
    /** At least one task was waiting. */
    some: DiagnosticsStall;
    /** Every task was waiting, so the machine did nothing useful. Absent for CPU. */
    full?: DiagnosticsStall;
}

export interface DiagnosticsPressureMetrics {
    memory?: DiagnosticsPressure;
    io?: DiagnosticsPressure;
    cpu?: DiagnosticsPressure;
}

export interface DiagnosticsPodMetrics {
    name: string;
    component?: DiagnosticsComponentName | "server";
    /** From metrics-server; absent when it is not installed. */
    cpuUsedCores?: number;
    memoryUsedBytes?: number;
}

export interface DiagnosticsPvcMetrics {
    name: string;
    phase: string;
    storageClass?: string;
    requestedBytes?: number;
    /** The volume's allocation: the PVC's provisioned capacity, else what it requested. */
    capacityBytes?: number;
    /**
     * What the volume itself holds. Only for a PVC mounted in the server pod (`mountedByServer`): a Role can't ask the kubelet
     * about the others. `measuredBy` says how it was found.
     */
    usedBytes?: number;
    /** Room left on the filesystem the volume is on: the node's disk when `sharesNodeDisk`, which the volume's allocation does not limit. */
    availableBytes?: number;
    /**
     * `filesystem`: the volume is a filesystem of its own, so its usage is the filesystem's. `directory`: it shares the node's
     * disk (`sharesNodeDisk`), so the filesystem's usage would be the whole disk's and its directory was measured instead.
     */
    measuredBy?: "filesystem" | "directory";
    /** The directory could not be measured completely (a very large tree, or something unreadable), so `usedBytes` is a lower bound. */
    usedPartial?: boolean;
    mountedByServer: boolean;
    /**
     * The volume is a directory of the node's disk (a hostPath-style volume such as k3s's default local-path), whose allocation
     * is not enforced.
     */
    sharesNodeDisk?: boolean;
}

export interface DiagnosticsProcessMetrics {
    /** Percent of one core, so a process using two cores reads 200. */
    cpuPercent: number;
    rssBytes: number;
    heapUsedBytes: number;
    heapTotalBytes: number;
    loadAverage: [number, number, number];
    /** The container's memory limit when it has one, else the host's memory. */
    systemMemoryTotalBytes: number;
    systemMemoryFreeBytes: number;
    cpuCount: number;
}

export interface DiagnosticsMetrics {
    collectedAt: string;
    process: DiagnosticsProcessMetrics;
    host: DiagnosticsHostMetrics;
    kubernetes: DiagnosticsAvailability & {
        namespace?: {
            name: string;
            /** False when metrics-server is not installed, or the Role does not cover it (`podMetricsReason` says which). */
            podMetricsAvailable: boolean;
            podMetricsReason?: string;
            cpuUsedCores?: number;
            memoryUsedBytes?: number;
            pods: DiagnosticsPodMetrics[];
        };
        pvcs: DiagnosticsPvcMetrics[];
        errors: string[];
    };
}
