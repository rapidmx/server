///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
import { classifyContainer, imageDigest, imageTag } from "./components.js";
import type { KubeClient } from "./KubeClient.js";
import {
    DIAGNOSTICS_COMPONENTS,
    type DiagnosticsComponent,
    type DiagnosticsComponentName,
    type DiagnosticsNode,
    type DiagnosticsPod,
    type DiagnosticsRuntime,
    type KubernetesDistribution,
} from "./types.js";

/** The parts of a Kubernetes `Pod` this reads. */
export interface KubePod {
    metadata?: { name?: string; labels?: Record<string, string> };
    spec?: {
        nodeName?: string;
        containers?: { name: string; image?: string; volumeMounts?: { name: string; mountPath: string }[] }[];
        volumes?: { name: string; persistentVolumeClaim?: { claimName: string } }[];
    };
    status?: {
        phase?: string;
        hostIP?: string;
        startTime?: string;
        containerStatuses?: {
            name: string;
            image?: string;
            imageID?: string;
            ready?: boolean;
            restartCount?: number;
        }[];
    };
}

/** A pod, and the component (if any) its containers make it. */
export interface ClassifiedPod {
    pod: DiagnosticsPod;
    component?: DiagnosticsComponentName;
    /** The tag of the container that made the pod a component. */
    version?: string;
    labels: Record<string, string>;
    hostIP?: string;
    /** The PVCs the pod mounts, and where. */
    claims: { claimName: string; mountPath: string }[];
}

export function classifyPod(kubePod: KubePod): ClassifiedPod {
    const statuses = kubePod.status?.containerStatuses ?? [];
    const specs = kubePod.spec?.containers ?? [];
    const names = new Set([...specs.map((c) => c.name), ...statuses.map((s) => s.name)]);
    const containers = [...names].map((name) => {
        const status = statuses.find((s) => s.name === name);
        const image = specs.find((c) => c.name === name)?.image ?? status?.image ?? "";
        return {
            name,
            image,
            tag: imageTag(image),
            digest: imageDigest(status?.imageID),
            ready: status?.ready === true,
            restartCount: status?.restartCount ?? 0,
        };
    });
    const main = containers.find((c) => classifyContainer(c.name, c.image));
    return {
        pod: {
            name: kubePod.metadata?.name ?? "",
            phase: kubePod.status?.phase ?? "Unknown",
            ready: containers.length > 0 && containers.every((c) => c.ready),
            restarts: containers.reduce((sum, c) => sum + c.restartCount, 0),
            node: kubePod.spec?.nodeName,
            startedAt: kubePod.status?.startTime,
            containers,
        },
        component: main ? classifyContainer(main.name, main.image) : undefined,
        version: main?.tag,
        labels: kubePod.metadata?.labels ?? {},
        hostIP: kubePod.status?.hostIP,
        claims: podClaims(kubePod),
    };
}

function podClaims(kubePod: KubePod): { claimName: string; mountPath: string }[] {
    const claimOf = new Map((kubePod.spec?.volumes ?? []).map((v) => [v.name, v.persistentVolumeClaim?.claimName]));
    const claims: { claimName: string; mountPath: string }[] = [];
    for (const container of kubePod.spec?.containers ?? []) {
        for (const mount of container.volumeMounts ?? []) {
            const claimName = claimOf.get(mount.name);
            if (claimName) {
                claims.push({ claimName, mountPath: mount.mountPath });
            }
        }
    }
    return claims;
}

/** Every component, in display order, with the pods that run it. `pods` is undefined when Kubernetes could not be asked. */
export function buildComponents(pods: ClassifiedPod[] | undefined): DiagnosticsComponent[] {
    return DIAGNOSTICS_COMPONENTS.map((component) => {
        if (!pods) {
            return { component, status: "unknown", pods: [] };
        }
        const mine = pods.filter((p) => p.component === component);
        const running = mine.find((p) => p.pod.ready);
        return {
            component,
            status: mine.length === 0 ? "missing" : running ? "running" : "not-ready",
            version: (running ?? mine[0])?.version,
            pods: mine.map((p) => p.pod),
        };
    });
}

export function distributionOf(gitVersion: string): KubernetesDistribution {
    if (/\+k3s/.test(gitVersion)) return "k3s";
    if (/\+rke2/.test(gitVersion)) return "rke2";
    if (/-eks-/.test(gitVersion)) return "eks";
    if (/-gke\./.test(gitVersion)) return "gke";
    if (/-aks/.test(gitVersion)) return "aks";
    return "kubernetes";
}

export function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

export async function listPods(client: KubeClient, namespace: string): Promise<ClassifiedPod[]> {
    const list = await client.get<{ items?: KubePod[] }>(`/api/v1/namespaces/${encodeURIComponent(namespace)}/pods`);
    return (list.items ?? []).map(classifyPod);
}

/** The nodes that run the namespace's pods, as the pods report them: nodes themselves are cluster-scoped, which the Role can't read. */
export function nodesOf(pods: ClassifiedPod[]): DiagnosticsNode[] {
    const nodes = new Map<string, DiagnosticsNode>();
    for (const { pod, hostIP } of pods) {
        if (!pod.node) {
            continue;
        }
        const node = nodes.get(pod.node) ?? { name: pod.node, internalIP: hostIP, podCount: 0 };
        node.podCount++;
        node.internalIP ??= hostIP;
        nodes.set(pod.node, node);
    }
    return [...nodes.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** The Kubernetes version (readable by any authenticated account) and the nodes the namespace's pods run on, or why not. */
export async function collectRuntime(client: KubeClient | undefined, reason: string | undefined, namespace: string): Promise<DiagnosticsRuntime> {
    if (!client) {
        return { available: false, reason, nodes: [] };
    }
    try {
        const version = await client.get<any>("/version");
        const pods = await listPods(client, namespace).catch(() => undefined);
        return {
            available: true,
            namespace,
            version: {
                gitVersion: version.gitVersion ?? "",
                major: version.major ?? "",
                minor: version.minor ?? "",
                platform: version.platform ?? "",
                goVersion: version.goVersion,
                buildDate: version.buildDate,
                distribution: distributionOf(version.gitVersion ?? ""),
            },
            nodes: pods ? nodesOf(pods) : [],
        };
    } catch (err) {
        return { available: false, reason: errorMessage(err), namespace, nodes: [] };
    }
}
