///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
import { readFile } from "node:fs/promises";
import https from "node:https";

export const SERVICE_ACCOUNT_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";

/** The most a Kubernetes API answer may weigh; a pod list of a big namespace is a few MB at most. */
const MAX_BODY_BYTES = 32 * 1024 * 1024;

export interface KubeRequest {
    /** GET unless said otherwise. The only write is the PUT of the configuration keyring Secret (`KubernetesConfigKeyringStore`). */
    method?: "GET" | "PUT";
    url: URL;
    headers: Record<string, string>;
    /** The JSON text of a PUT. */
    body?: string;
    /** PEM CA certificate(s) to verify the peer with (the cluster's, from the service account). */
    ca?: string;
    rejectUnauthorized: boolean;
    timeoutMs: number;
}

export interface KubeResponse {
    status: number;
    body: string;
}

/** Performs one request. Replaceable so tests need no cluster. */
export type KubeTransport = (request: KubeRequest) => Promise<KubeResponse>;

/** An error answer, or no answer, from the API server. */
export class KubeError extends Error {
    /** The HTTP status, when the peer answered. */
    status?: number;

    constructor(message: string, status?: number) {
        super(message);
        this.name = "KubeError";
        this.status = status;
    }
}

export function httpsTransport(request: KubeRequest): Promise<KubeResponse> {
    return new Promise((resolve, reject) => {
        const req = https.request(
            request.url,
            {
                method: request.method ?? "GET",
                headers: request.headers,
                ca: request.ca,
                rejectUnauthorized: request.rejectUnauthorized,
                timeout: request.timeoutMs,
            },
            (res) => {
                const chunks: Buffer[] = [];
                let size = 0;
                res.on("data", (chunk: Buffer) => {
                    size += chunk.length;
                    if (size > MAX_BODY_BYTES) {
                        req.destroy(new Error("the response was too large"));
                        return;
                    }
                    chunks.push(chunk);
                });
                res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
                res.on("error", reject);
            }
        );
        req.on("timeout", () => req.destroy(new Error(`no answer within ${request.timeoutMs} ms`)));
        req.on("error", reject);
        req.end(request.body);
    });
}

export interface KubeClientOptions {
    /** The API server host and port, from the pod's `KUBERNETES_SERVICE_HOST`/`_PORT`. */
    host: string;
    port: string;
    serviceAccountDir?: string;
    timeoutMs?: number;
    transport?: KubeTransport;
}

/**
 * A minimal Kubernetes client for the pod's own service account: JSON GETs against the API server, and the one PUT that replaces the configuration keyring Secret
 * (the chart's Role allows it nowhere else). It is not `@kubernetes/client-node` on purpose - the Diagnostics page reads a handful of endpoints, all inside its own
 * namespace, and this keeps a large dependency, and its own transitive ones, out of the mail server.
 */
export class KubeClient {
    private readonly dir: string;
    private readonly timeoutMs: number;
    private readonly transport: KubeTransport;
    private ca?: string;

    constructor(private readonly options: KubeClientOptions) {
        this.dir = options.serviceAccountDir ?? SERVICE_ACCOUNT_DIR;
        this.timeoutMs = options.timeoutMs ?? 5000;
        this.transport = options.transport ?? httpsTransport;
    }

    /**
     * A client for the pod's service account, or the reason there is none: outside a cluster (Docker Compose, `yarn dev`) or
     * in a pod that doesn't mount its token (`automountServiceAccountToken: false`).
     */
    static async detect(
        options: Omit<KubeClientOptions, "host" | "port"> & { env?: NodeJS.ProcessEnv } = {}
    ): Promise<{ client?: KubeClient; reason?: string }> {
        const env = options.env ?? process.env;
        const host = env.KUBERNETES_SERVICE_HOST;
        if (!host) {
            return { reason: "This server is not running in Kubernetes (KUBERNETES_SERVICE_HOST is not set)." };
        }
        const client = new KubeClient({ ...options, host, port: env.KUBERNETES_SERVICE_PORT || "443" });
        try {
            await client.token();
        } catch {
            return { reason: "The pod has no service account token mounted, so it cannot ask Kubernetes about itself." };
        }
        return { client };
    }

    /** The namespace this pod runs in, from its service account. */
    async namespace(): Promise<string> {
        return (await readFile(`${this.dir}/namespace`, "utf8")).trim();
    }

    /** Read on every request: a bound service account token is rotated by the kubelet. */
    private async token(): Promise<string> {
        return (await readFile(`${this.dir}/token`, "utf8")).trim();
    }

    private async clusterCa(): Promise<string | undefined> {
        if (this.ca === undefined) {
            try {
                this.ca = await readFile(`${this.dir}/ca.crt`, "utf8");
            } catch {
                this.ca = "";
            }
        }
        return this.ca || undefined;
    }

    /** GETs `path` (e.g. `/version`) from the API server. */
    async get<T>(path: string): Promise<T> {
        return this.send<T>("GET", path);
    }

    /**
     * PUTs `body` (as JSON) to `path`, replacing the object there. The body's `metadata.resourceVersion` makes the API server refuse the write (409) when the object
     * changed since it was read. Errors name the host, path and status, never the body.
     */
    async put<T>(path: string, body: unknown): Promise<T> {
        return this.send<T>("PUT", path, JSON.stringify(body));
    }

    private async send<T>(method: "GET" | "PUT", path: string, body?: string): Promise<T> {
        const host = this.options.host.includes(":") ? `[${this.options.host}]` : this.options.host;
        return this.getJson<T>(new URL(`https://${host}:${this.options.port}${path}`), method, body);
    }

    private async getJson<T>(url: URL, method: "GET" | "PUT", body?: string): Promise<T> {
        const token = await this.token();
        let response: KubeResponse;
        try {
            response = await this.transport({
                method,
                url,
                headers: {
                    Accept: "application/json",
                    Authorization: `Bearer ${token}`,
                    ...(body !== undefined ? { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(body)) } : {}),
                },
                ...(body !== undefined ? { body } : {}),
                ca: await this.clusterCa(),
                rejectUnauthorized: true,
                timeoutMs: this.timeoutMs,
            });
        } catch (err: any) {
            throw new KubeError(`${url.host}${url.pathname}: ${err?.code ?? err?.message ?? String(err)}`);
        }
        if (response.status < 200 || response.status >= 300) {
            throw new KubeError(`${url.host}${url.pathname}: HTTP ${response.status}${forbiddenHint(response.status, method)}`, response.status);
        }
        try {
            return JSON.parse(response.body) as T;
        } catch {
            throw new KubeError(`${url.host}${url.pathname}: the answer was not JSON`, response.status);
        }
    }
}

function forbiddenHint(status: number, method: "GET" | "PUT"): string {
    if (status !== 401 && status !== 403) {
        return "";
    }
    return method === "PUT"
        ? " (the server's service account may not update this; the Helm chart's configEncryption.rbac.create grants it for the keyring Secret only)"
        : " (the server's service account may not read this; the Helm chart's global.diagnostics.rbac.create grants it, in this namespace only)";
}
