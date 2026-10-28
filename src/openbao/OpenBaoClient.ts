///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { readFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";

/** Where the chart mounts the server's projected ServiceAccount token for OpenBao (audience `openbao`, rotated by the kubelet). */
export const DEFAULT_OPENBAO_TOKEN_FILE = "/var/run/secrets/openbao/token";

const DEFAULT_TIMEOUT_MS = 10_000;

/** The most an OpenBao answer may weigh: a signed certificate or a secret is a few kB. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** Log in again once this share of the token's lease has passed, well before it expires. */
const RELOGIN_AT_LEASE_SHARE = 2 / 3;

/**
 * A 403 to a token younger than this is a policy denial, answered as it is: OpenBao refuses a path the role may not use with the
 * same 403 as a revoked token, and logging in again for each such request would pile up tokens and leases in the vault.
 */
const FRESH_TOKEN_MS = 60_000;

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);

export interface OpenBaoHttpRequest {
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    url: URL;
    headers: Record<string, string>;
    body?: string;
    /** PEM CA certificate(s) to verify the peer with; the system's trust store when unset. */
    ca?: string;
    timeoutMs: number;
}

export interface OpenBaoHttpResponse {
    status: number;
    body: string;
}

/** Performs one request. Replaceable so tests need no vault. */
export type OpenBaoTransport = (request: OpenBaoHttpRequest) => Promise<OpenBaoHttpResponse>;

/** How a client authenticates: a static token (a vault prepared by hand, `docker-compose.openbao.yml`), or OpenBao's `kubernetes` auth method. */
export type OpenBaoAuth =
    | { method: "token"; token: string }
    | {
          method: "kubernetes";
          /** The OpenBao role to log in as (the installer's `<fullname>-server`). */
          role: string;
          /** The path the `kubernetes` auth method is mounted at. */
          mountPath: string;
          /** The projected ServiceAccount token, read again for every login: the kubelet rotates it. */
          tokenFile: string;
      };

export interface OpenBaoClientOptions {
    /** The configuration prefix the settings came from (`mail:pki:openbao`), named in messages. */
    name: string;
    address: string;
    /** A PEM bundle to verify OpenBao's listener with (the installer's copy of the CA that signed it), read on every request. */
    caFile?: string;
    auth: OpenBaoAuth;
    timeoutMs?: number;
    transport?: OpenBaoTransport;
    readFile?: (path: string) => Promise<string>;
    now?: () => number;
}

/** A request OpenBao didn't answer as asked. Never carries a token, a ServiceAccount token or a response body (which may hold a secret). */
export class OpenBaoError extends Error {
    /** "config": the settings can't work, so nothing was sent; "unreachable": no answer; "rejected": OpenBao answered with an error. */
    readonly kind: "config" | "unreachable" | "rejected";
    /** The HTTP status, when OpenBao answered. */
    readonly status?: number;

    constructor(kind: OpenBaoError["kind"], message: string, status?: number) {
        super(message);
        this.name = "OpenBaoError";
        this.kind = kind;
        this.status = status;
    }
}

export function nodeTransport(request: OpenBaoHttpRequest): Promise<OpenBaoHttpResponse> {
    return new Promise((resolve, reject) => {
        const headers: Record<string, string> = { ...request.headers };
        if (request.body !== undefined) {
            headers["Content-Length"] = String(Buffer.byteLength(request.body));
        }
        const secure: boolean = request.url.protocol === "https:";
        // Redirects are never followed (node doesn't), so the token can't be sent on to another host.
        const req = (secure ? https : http).request(
            request.url,
            {
                method: request.method,
                headers,
                timeout: request.timeoutMs,
                ...(secure ? { ca: request.ca, rejectUnauthorized: true } : {}),
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
        if (request.body !== undefined) {
            req.write(request.body);
        }
        req.end();
    });
}

/** OpenBao's own error messages from an answer (`{"errors": [...]}`), which name the problem and never a secret; nothing else of the body. */
function errorsOf(body: string): string {
    try {
        const errors: unknown = JSON.parse(body)?.errors;
        if (Array.isArray(errors)) {
            const text: string = errors.filter((e) => typeof e === "string").join("; ");
            return text ? ` (${text.slice(0, 300)})` : "";
        }
    } catch {
        // Not JSON: say nothing of it.
    }
    return "";
}

/**
 * A small OpenBao HTTP client for the server: its encryption CA's PKI mount. It verifies the
 * listener against a configured CA bundle (the installer's in-cluster OpenBao has a certificate from a CA of its own, which neither
 * the system's trust store nor the global `fetch` can be given per request), and logs in with OpenBao's `kubernetes` auth method using
 * the pod's projected ServiceAccount token, logging in again before its short-lived OpenBao token expires, or once when OpenBao no
 * longer takes it. A static token still works for a vault prepared by hand.
 *
 * Like restapi's `OpenBaoPkiCertificateAuthority`, it sends a token only over https, or plain HTTP to this host.
 */
export class OpenBaoClient {
    private readonly base: URL;
    private readonly timeoutMs: number;
    private readonly transport: OpenBaoTransport;
    private readonly read: (path: string) => Promise<string>;
    private readonly now: () => number;
    private token?: string;
    private tokenRenewAt: number = 0;
    private tokenIssuedAt: number = 0;
    private login?: Promise<string>;

    constructor(private readonly options: OpenBaoClientOptions) {
        let parsed: URL;
        try {
            parsed = new URL(options.address);
        } catch {
            throw new OpenBaoError("config", `${options.name}:address is not a valid URL.`);
        }
        if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && LOOPBACK_HOSTS.has(parsed.hostname))) {
            throw new OpenBaoError(
                "config",
                `${options.name}:address must use https:// unless it targets this host: a token is never sent over plaintext HTTP to another host.`
            );
        }
        this.base = new URL(parsed.toString().replace(/\/+$/, "") + "/v1/");
        this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        this.transport = options.transport ?? nodeTransport;
        this.read = options.readFile ?? ((file) => readFile(file, "utf8"));
        this.now = options.now ?? Date.now;
    }

    /**
     * Sends `body` (as JSON) to `/v1/<path>` and answers the parsed JSON, or `undefined` for an answer without one (204). With
     * Kubernetes auth, a request OpenBao refuses with 403 is sent once more after logging in again (the token may have been revoked),
     * unless the token was minted within the last minute: so a path the role may not use costs at most one login a minute.
     */
    async request<T>(method: OpenBaoHttpRequest["method"], path: string, body?: unknown): Promise<T | undefined> {
        const token: string = await this.currentToken();
        const response: OpenBaoHttpResponse = await this.send(method, path, body, token);
        if (response.status === 403 && this.options.auth.method === "kubernetes" && !this.isFresh(token)) {
            this.forget(token);
            return this.parse<T>(method, path, await this.send(method, path, body, await this.currentToken()));
        }
        return this.parse<T>(method, path, response);
    }

    private parse<T>(method: string, path: string, response: OpenBaoHttpResponse): T | undefined {
        if (response.status < 200 || response.status >= 300) {
            throw new OpenBaoError("rejected", `${this.options.name}: ${method} ${path}: HTTP ${response.status}${errorsOf(response.body)}`, response.status);
        }
        if (response.status === 204 || response.body.trim() === "") {
            return undefined;
        }
        try {
            return JSON.parse(response.body) as T;
        } catch {
            throw new OpenBaoError("rejected", `${this.options.name}: ${method} ${path}: the answer was not JSON`, response.status);
        }
    }

    private async send(method: OpenBaoHttpRequest["method"], path: string, body: unknown, token?: string): Promise<OpenBaoHttpResponse> {
        const headers: Record<string, string> = {};
        if (token !== undefined) {
            headers["X-Vault-Token"] = token;
        }
        if (body !== undefined) {
            headers["Content-Type"] = "application/json";
        }
        const request: OpenBaoHttpRequest = {
            method,
            url: new URL(path.replace(/^\/+/, ""), this.base),
            headers,
            ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
            ca: await this.caBundle(),
            timeoutMs: this.timeoutMs,
        };
        try {
            return await this.transport(request);
        } catch (err: any) {
            throw new OpenBaoError("unreachable", `${this.options.name}: ${method} ${path}: ${err?.code ?? err?.message ?? String(err)}`);
        }
    }

    /** Read on every request, so a CA the installer copied again is used without a restart. */
    private async caBundle(): Promise<string | undefined> {
        if (!this.options.caFile) {
            return undefined;
        }
        try {
            return await this.read(this.options.caFile);
        } catch (err: any) {
            throw new OpenBaoError("config", `${this.options.name}:ca_file '${this.options.caFile}' can't be read: ${err?.code ?? err?.message ?? String(err)}`);
        }
    }

    private async currentToken(): Promise<string> {
        const auth: OpenBaoAuth = this.options.auth;
        if (auth.method === "token") {
            return auth.token;
        }
        if (this.token !== undefined && this.now() < this.tokenRenewAt) {
            return this.token;
        }
        // One login for every request waiting on it.
        this.login ??= this.logIn(auth).finally(() => (this.login = undefined));
        return this.login;
    }

    private isFresh(token: string): boolean {
        return this.token === token && this.now() - this.tokenIssuedAt < FRESH_TOKEN_MS;
    }

    private forget(token: string): void {
        if (this.token === token) {
            this.token = undefined;
        }
    }

    private async logIn(auth: Extract<OpenBaoAuth, { method: "kubernetes" }>): Promise<string> {
        let jwt: string;
        try {
            jwt = (await this.read(auth.tokenFile)).trim();
        } catch (err: any) {
            throw new OpenBaoError("config", `${this.options.name}: no ServiceAccount token at ${auth.tokenFile} to log in with: ${err?.code ?? err?.message ?? String(err)}`);
        }
        if (!jwt) {
            throw new OpenBaoError("config", `${this.options.name}: the ServiceAccount token at ${auth.tokenFile} is empty.`);
        }
        const path = `auth/${auth.mountPath}/login`;
        const response: OpenBaoHttpResponse = await this.send("POST", path, { role: auth.role, jwt });
        if (response.status < 200 || response.status >= 300) {
            throw new OpenBaoError(
                "rejected",
                `${this.options.name}: logging in as role '${auth.role}' at ${path}: HTTP ${response.status}${errorsOf(response.body)}`,
                response.status
            );
        }
        let answer: any;
        try {
            answer = JSON.parse(response.body);
        } catch {
            answer = undefined;
        }
        const token: unknown = answer?.auth?.client_token;
        if (typeof token !== "string" || token === "") {
            throw new OpenBaoError("rejected", `${this.options.name}: logging in as role '${auth.role}' at ${path} gave no token.`, response.status);
        }
        const leaseSeconds: number = Number(answer.auth.lease_duration) || 0;
        this.token = token;
        this.tokenIssuedAt = this.now();
        // A lease of 0 is a token that doesn't expire.
        this.tokenRenewAt = leaseSeconds > 0 ? this.now() + leaseSeconds * 1000 * RELOGIN_AT_LEASE_SHARE : Number.POSITIVE_INFINITY;
        return token;
    }
}

/** The settings under a configuration prefix such as `mail:pki:openbao`, as nconf gives them. */
export interface OpenBaoSettings {
    address?: string;
    ca_file?: string;
    token?: string;
    timeout_ms?: number | string;
    auth?: {
        method?: string;
        role?: string;
        mount_path?: string;
        token_file?: string;
    };
}

/** Client options from the settings under `name`, refusing ones that can't work (Kubernetes auth without a role, an unknown method). */
export function openBaoClientOptions(name: string, settings: OpenBaoSettings): Omit<OpenBaoClientOptions, "transport" | "readFile" | "now"> {
    const method: string = settings.auth?.method || "token";
    const timeout: number = Number(settings.timeout_ms);
    const common = {
        name,
        address: settings.address ?? "",
        caFile: settings.ca_file || undefined,
        timeoutMs: settings.timeout_ms !== undefined && settings.timeout_ms !== "" && Number.isFinite(timeout) && timeout > 0 ? timeout : undefined,
    };
    if (method === "token") {
        return { ...common, auth: { method: "token", token: settings.token ?? "" } };
    }
    if (method === "kubernetes") {
        if (!settings.auth?.role) {
            throw new OpenBaoError("config", `${name}:auth:method is "kubernetes" but ${name}:auth:role is empty: set the OpenBao role to log in as.`);
        }
        return {
            ...common,
            auth: {
                method: "kubernetes",
                role: settings.auth.role,
                mountPath: settings.auth.mount_path || "kubernetes",
                tokenFile: settings.auth.token_file || DEFAULT_OPENBAO_TOKEN_FILE,
            },
        };
    }
    throw new OpenBaoError("config", `${name}:auth:method must be "token" or "kubernetes".`);
}

/** A client for the settings under `prefix` of `config` (the server's nconf), which must name an address. */
export function openBaoClientFromConfig(
    config: { get(key: string): unknown },
    prefix: string,
    overrides: Pick<OpenBaoClientOptions, "transport" | "readFile" | "now"> = {}
): OpenBaoClient {
    const value = (key: string): any => config.get(`${prefix}:${key}`);
    if (!value("address")) {
        throw new OpenBaoError("config", `${prefix}:address is empty.`);
    }
    const options = openBaoClientOptions(prefix, {
        address: value("address"),
        ca_file: value("ca_file"),
        token: value("token"),
        timeout_ms: value("timeout_ms"),
        auth: { method: value("auth:method"), role: value("auth:role"), mount_path: value("auth:mount_path"), token_file: value("auth:token_file") },
    });
    return new OpenBaoClient({ ...options, ...overrides });
}
