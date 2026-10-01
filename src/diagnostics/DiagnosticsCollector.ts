///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
import os from "node:os";
import path from "node:path";
import nconf from "nconf";
import { PLUGIN_SETTINGS_STORE } from "../config.defaults.js";
import { DirectorySizer, type SizeDirectory } from "./directorySize.js";
import { KubeClient, type KubeTransport } from "./KubeClient.js";
import { buildComponents, collectRuntime, errorMessage, listPods, type ClassifiedPod } from "./kubernetesInfo.js";
import { collectKubernetesMetrics, ProcessSampler, serverMounts } from "./metrics.js";
import { describeConfiguration, describeEnvironment } from "./redaction.js";
import { collectPackages, collectServerInfo, readPackageJson, type PackageJson } from "./serverInfo.js";
import type { DiagnosticsInformation, DiagnosticsMetrics, DiagnosticsPackage, DiagnosticsRuntime, DiagnosticsVersions } from "./types.js";

/** How long the installed-packages listing is reused; it only changes when the server is redeployed. */
const PACKAGES_TTL_MS = 60_000;

/** The merged configuration and the top-level keys the server's defaults declare, as `information()` reads them. */
export interface ConfigurationSource {
    tree: unknown;
    declared: string[];
}

/** The server's effective configuration: every layer of the shared `nconf` instance that `config.mongo.ts`/`config.sql.ts` set up. */
function nconfSource(): ConfigurationSource {
    const stores = (nconf as unknown as { stores?: Record<string, { store?: object } | undefined> }).stores;
    // A setting saved on a plugin is the server's own, not a copy of an environment variable, even when one starts with its key.
    return { tree: nconf.get(), declared: [...Object.keys(stores?.defaults?.store ?? {}), ...Object.keys(stores?.[PLUGIN_SETTINGS_STORE]?.store ?? {})] };
}

export interface DiagnosticsCollectorOptions {
    /** The directory holding the deployed `package.json` and `node_modules`. */
    root?: string;
    /** The namespace to inspect; empty is the pod's own. */
    namespace?: string;
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv;
    /** Reads the effective configuration. Defaults to the server's `nconf`. */
    configuration?: () => ConfigurationSource;
    serviceAccountDir?: string;
    transport?: KubeTransport;
    hostname?: () => string;
    now?: () => Date;
    /** Measures the directory of a volume that shares the node's disk. Defaults to a bounded walk (`measureDirectory`). */
    sizeDirectory?: SizeDirectory;
}

/**
 * Gathers what the admin console's Diagnostics page shows. Every question about Kubernetes degrades to an `available: false`
 * answer with a reason (outside a cluster, RBAC not granted, API unreachable) instead of failing the request, so the page
 * still shows the server's own details wherever it runs.
 */
export class DiagnosticsCollector {
    private kube?: Promise<{ client?: KubeClient; reason?: string }>;
    private packages?: { at: number; value: Promise<DiagnosticsPackage[]> };
    private readonly sampler = new ProcessSampler();
    private readonly sizer: DirectorySizer;

    constructor(private readonly options: DiagnosticsCollectorOptions = {}) {
        this.sizer = new DirectorySizer(options.sizeDirectory);
    }

    private get root(): string {
        return this.options.root ?? process.cwd();
    }

    private now(): Date {
        return this.options.now?.() ?? new Date();
    }

    private detect(): Promise<{ client?: KubeClient; reason?: string }> {
        this.kube ??= KubeClient.detect({
            env: this.options.env,
            serviceAccountDir: this.options.serviceAccountDir,
            timeoutMs: this.options.timeoutMs,
            transport: this.options.transport,
        });
        return this.kube;
    }

    private async namespace(client: KubeClient): Promise<string> {
        return this.options.namespace || client.namespace();
    }

    private hostname(): string {
        return this.options.hostname?.() ?? os.hostname();
    }

    private installedPackages(pkg: PackageJson | undefined): Promise<DiagnosticsPackage[]> {
        const now = this.now().getTime();
        if (!this.packages || now - this.packages.at > PACKAGES_TTL_MS) {
            this.packages = { at: now, value: collectPackages(this.root, pkg) };
        }
        return this.packages.value;
    }

    async versions(): Promise<DiagnosticsVersions> {
        const pkg = await readPackageJson(path.join(this.root, "package.json"));
        const [packages, kube] = await Promise.all([this.installedPackages(pkg), this.detect()]);
        const server = collectServerInfo(pkg, this.now());
        if (!kube.client) {
            return { server, packages, components: buildComponents(undefined), kubernetes: { available: false, reason: kube.reason } };
        }
        try {
            const pods = await listPods(kube.client, await this.namespace(kube.client));
            return { server, packages, components: buildComponents(pods), kubernetes: { available: true } };
        } catch (err) {
            return { server, packages, components: buildComponents(undefined), kubernetes: { available: false, reason: errorMessage(err) } };
        }
    }

    /**
     * The process environment and the effective configuration with every secret withheld (`redaction.ts`): the values of
     * secret-like and unrecognized names are not read into the answer at all.
     */
    information(): DiagnosticsInformation {
        const env = this.options.env ?? process.env;
        const { tree, declared } = (this.options.configuration ?? nconfSource)();
        return { environment: describeEnvironment(env), configuration: describeConfiguration(tree, env, declared) };
    }

    async runtime(): Promise<DiagnosticsRuntime> {
        const kube = await this.detect();
        if (!kube.client) {
            return collectRuntime(undefined, kube.reason, "");
        }
        try {
            return await collectRuntime(kube.client, undefined, await this.namespace(kube.client));
        } catch (err) {
            return { available: false, reason: errorMessage(err), nodes: [] };
        }
    }

    async metrics(): Promise<DiagnosticsMetrics> {
        const kube = await this.detect();
        const collectedAt = this.now().toISOString();
        const processMetrics = this.sampler.sample();
        const unavailable = (reason: string | undefined) => ({ available: false, reason, pvcs: [], errors: [] });

        let namespace: string | undefined;
        let pods: ClassifiedPod[] | undefined;
        let reason = kube.reason;
        if (kube.client) {
            try {
                namespace = await this.namespace(kube.client);
                pods = await listPods(kube.client, namespace);
            } catch (err) {
                reason = `Could not list the pods: ${errorMessage(err)}`;
            }
        }

        // The disks behind the server's own PVC mounts are measured from inside the container; a Role can't ask the kubelet.
        const host = await this.sampler.host(pods ? serverMounts(pods, this.hostname()) : []);
        if (!kube.client || !pods || namespace === undefined) {
            return { collectedAt, process: processMetrics, host, kubernetes: unavailable(reason) };
        }
        const mounted = new Map(host.disks.filter((d) => d.pvc).map((d) => [d.pvc as string, d]));
        try {
            const kubernetes = await collectKubernetesMetrics(kube.client, namespace, this.hostname(), pods, mounted, (dir) =>
                this.sizer.size(dir)
            );
            for (const disk of host.disks) {
                disk.sharesNodeDisk = kubernetes.pvcs.find((p) => p.name === disk.pvc)?.sharesNodeDisk;
            }
            return { collectedAt, process: processMetrics, host, kubernetes };
        } catch (err) {
            return { collectedAt, process: processMetrics, host, kubernetes: unavailable(errorMessage(err)) };
        }
    }
}
