///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { KubeClient, type KubeRequest, type KubeResponse } from "../../src/diagnostics/KubeClient.js";

/** A pod as the fake API server holds it. */
export interface FakePod {
    name: string;
    labels?: Record<string, string>;
    phase?: string;
    terminating?: boolean;
}

/** A Secret as the fake API server holds it. */
export interface FakeSecret {
    metadata: Record<string, any>;
    type?: string;
    data: Record<string, string>;
}

/**
 * A stand-in for the cluster's API server, as the server's service account sees it: reads and replaces the one Secret named in `secrets` (by
 * `resourceVersion`, as Kubernetes does), lists pods by label selector, and answers 403 for everything else - which is what the chart's Roles do.
 */
export class FakeKubernetes {
    public readonly requests: KubeRequest[] = [];
    public readonly secrets: Map<string, FakeSecret> = new Map();
    public pods: FakePod[] = [];
    /** Set to answer every request with this status instead. */
    public failWith?: number;
    /** Runs when a PUT arrives, before it is judged: another writer getting in between the server's read and its write. */
    public beforePut?: () => void;
    private nextVersion = 100;

    constructor(public readonly namespace: string = "mail") {}

    public addSecret(name: string, data: Record<string, string>, metadata: Record<string, any> = {}): FakeSecret {
        const secret: FakeSecret = {
            metadata: { name, namespace: this.namespace, uid: `uid-${name}`, resourceVersion: String(this.nextVersion++), managedFields: [{ manager: "helm" }], ...metadata },
            type: "Opaque",
            data,
        };
        this.secrets.set(name, secret);
        return secret;
    }

    /** Changes the Secret behind the server's back, as another writer would. */
    public touch(name: string, data: Record<string, string>): void {
        const secret: FakeSecret = this.secrets.get(name)!;
        secret.data = data;
        secret.metadata.resourceVersion = String(this.nextVersion++);
    }

    public readonly transport = async (request: KubeRequest): Promise<KubeResponse> => {
        this.requests.push(request);
        if (this.failWith !== undefined) {
            return { status: this.failWith, body: "{}" };
        }
        const method: string = request.method ?? "GET";
        const secretMatch = request.url.pathname.match(new RegExp(`^/api/v1/namespaces/${this.namespace}/secrets/([^/]+)$`));
        if (secretMatch) {
            const secret: FakeSecret | undefined = this.secrets.get(secretMatch[1]);
            if (!secret) {
                return { status: 404, body: "{}" };
            }
            if (method === "GET") {
                return { status: 200, body: JSON.stringify({ apiVersion: "v1", kind: "Secret", ...secret }) };
            }
            if (method === "PUT") {
                this.beforePut?.();
                const body: any = JSON.parse(request.body ?? "{}");
                if (body.metadata?.name !== secretMatch[1] || body.metadata?.resourceVersion !== secret.metadata.resourceVersion) {
                    return { status: 409, body: '{"reason":"Conflict"}' };
                }
                secret.data = body.data;
                secret.type = body.type ?? secret.type;
                secret.metadata = { ...body.metadata, resourceVersion: String(this.nextVersion++) };
                return { status: 200, body: JSON.stringify({ apiVersion: "v1", kind: "Secret", ...secret }) };
            }
        }
        if (method === "GET" && request.url.pathname === `/api/v1/namespaces/${this.namespace}/pods`) {
            const selector: string = request.url.searchParams.get("labelSelector") ?? "";
            const wanted: [string, string][] = selector === "" ? [] : selector.split(",").map((term) => term.split("=") as [string, string]);
            const items = this.pods
                .filter((pod) => wanted.every(([key, value]) => pod.labels?.[key] === value))
                .map((pod) => this.podBody(pod));
            return { status: 200, body: JSON.stringify({ items }) };
        }
        const podMatch = request.url.pathname.match(new RegExp(`^/api/v1/namespaces/${this.namespace}/pods/([^/]+)$`));
        if (method === "GET" && podMatch) {
            const pod: FakePod | undefined = this.pods.find((candidate) => candidate.name === podMatch[1]);
            return pod ? { status: 200, body: JSON.stringify(this.podBody(pod)) } : { status: 404, body: "{}" };
        }
        // Anything else - another Secret verb, another resource - is outside the Roles.
        return { status: 403, body: "{}" };
    };

    private podBody(pod: FakePod): unknown {
        return {
            metadata: { name: pod.name, labels: pod.labels ?? {}, ...(pod.terminating ? { deletionTimestamp: "2026-10-28T00:00:00Z" } : {}) },
            status: { phase: pod.phase ?? "Running" },
        };
    }

    /** A client for the pod's service account, with the token and namespace in a scratch directory. */
    public async client(): Promise<KubeClient> {
        const dir: string = await mkdtemp(path.join(os.tmpdir(), "fake-sa-"));
        await writeFile(path.join(dir, "token"), "tok");
        await writeFile(path.join(dir, "namespace"), this.namespace);
        return new KubeClient({ host: "10.43.0.1", port: "443", serviceAccountDir: dir, transport: this.transport });
    }
}
