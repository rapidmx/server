///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
import {
    DEFAULT_OPENBAO_TOKEN_FILE,
    OpenBaoClient,
    OpenBaoClientOptions,
    OpenBaoError,
    OpenBaoHttpRequest,
    OpenBaoHttpResponse,
    openBaoClientFromConfig,
    openBaoClientOptions,
} from "../../src/openbao/OpenBaoClient.js";

const JWT = "eyJhbGciOiJSUzI1NiJ9.service-account.signature";
const CA = "-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----\n";

/** A fake OpenBao: answers each request with `answer(request)`, recording what it was sent. */
function fakeOpenBao(answer: (request: OpenBaoHttpRequest, index: number) => OpenBaoHttpResponse | Promise<OpenBaoHttpResponse>) {
    const requests: OpenBaoHttpRequest[] = [];
    const transport = vi.fn(async (request: OpenBaoHttpRequest) => {
        requests.push(request);
        return answer(request, requests.length - 1);
    });
    return { requests, transport };
}

const json = (status: number, body: unknown): OpenBaoHttpResponse => ({ status, body: JSON.stringify(body) });

const login = (token: string, leaseSeconds = 3600) => json(200, { auth: { client_token: token, lease_duration: leaseSeconds, renewable: true } });

/** Files the client reads: the projected ServiceAccount token and the CA bundle. */
function files(entries: Record<string, string>) {
    return vi.fn(async (path: string) => {
        if (!(path in entries)) {
            throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), { code: "ENOENT" });
        }
        return entries[path];
    });
}

function kubernetesClient(overrides: Partial<OpenBaoClientOptions> = {}): OpenBaoClient {
    return new OpenBaoClient({
        name: "mail:pki:openbao",
        address: "https://openbao.openbao.svc:8200",
        caFile: "/etc/rapidmx/openbao-ca/ca.crt",
        auth: { method: "kubernetes", role: "rapidmx-server", mountPath: "kubernetes", tokenFile: "/var/run/secrets/openbao/token" },
        readFile: files({ "/var/run/secrets/openbao/token": `${JWT}\n`, "/etc/rapidmx/openbao-ca/ca.crt": CA }),
        ...overrides,
    });
}

describe("OpenBaoClient", () => {
    describe("addresses", () => {
        it("refuses plain HTTP to anything but this host, before sending anything", () => {
            for (const address of ["http://openbao.openbao.svc:8200", "http://10.0.0.5:8200", "ftp://openbao:8200"]) {
                expect(() => new OpenBaoClient({ name: "mail:pki:openbao", address, auth: { method: "token", token: "t" } })).toThrow(
                    /must use https:\/\/ unless it targets this host/
                );
            }
        });

        it("refuses an address that isn't a URL, without repeating it", () => {
            let error: OpenBaoError | undefined;
            try {
                new OpenBaoClient({ name: "mail:pki:openbao", address: "not a url", auth: { method: "token", token: "t" } });
            } catch (err: any) {
                error = err;
            }
            expect(error).toBeInstanceOf(OpenBaoError);
            expect(error?.kind).toBe("config");
            expect(error?.message).toContain("mail:pki:openbao:address");
        });

        it("accepts https anywhere and plain HTTP on loopback", () => {
            for (const address of ["https://openbao.openbao.svc:8200", "http://127.0.0.1:8200", "http://[::1]:8200", "http://localhost:8200"]) {
                expect(() => new OpenBaoClient({ name: "x", address, auth: { method: "token", token: "t" } })).not.toThrow();
            }
        });
    });

    describe("with a static token", () => {
        it("sends the token, the JSON body and the configured CA, and parses the answer", async () => {
            const bao = fakeOpenBao(() => json(200, { data: { certificate: "PEM" } }));
            const client = new OpenBaoClient({
                name: "mail:pki:openbao",
                address: "https://openbao.example.com:8200/",
                caFile: "/ca.pem",
                auth: { method: "token", token: "s.static" },
                transport: bao.transport,
                readFile: files({ "/ca.pem": CA }),
                timeoutMs: 1234,
            });

            const answer = await client.request<{ data: { certificate: string } }>("POST", "pki/sign/rapidmx", { csr: "CSR" });

            expect(answer).toEqual({ data: { certificate: "PEM" } });
            expect(bao.requests).toHaveLength(1);
            const [request] = bao.requests;
            expect(request.method).toBe("POST");
            expect(request.url.toString()).toBe("https://openbao.example.com:8200/v1/pki/sign/rapidmx");
            expect(request.headers["X-Vault-Token"]).toBe("s.static");
            expect(request.headers["Content-Type"]).toBe("application/json");
            expect(JSON.parse(request.body!)).toEqual({ csr: "CSR" });
            expect(request.ca).toBe(CA);
            expect(request.timeoutMs).toBe(1234);
        });

        it("answers undefined for 204 No Content, and sends no body or content type without one", async () => {
            const bao = fakeOpenBao(() => ({ status: 204, body: "" }));
            const client = new OpenBaoClient({ name: "x", address: "http://127.0.0.1:8200", auth: { method: "token", token: "t" }, transport: bao.transport });

            expect(await client.request("DELETE", "secret/metadata/a")).toBeUndefined();
            expect(bao.requests[0].body).toBeUndefined();
            expect(bao.requests[0].headers["Content-Type"]).toBeUndefined();
            // Without a CA file the system's trust store applies.
            expect(bao.requests[0].ca).toBeUndefined();
        });

        it("re-reads the CA file on every request, so a renewed CA is picked up", async () => {
            const bao = fakeOpenBao(() => json(200, {}));
            let ca = "first";
            const client = new OpenBaoClient({
                name: "x",
                address: "https://bao:8200",
                caFile: "/ca.pem",
                auth: { method: "token", token: "t" },
                transport: bao.transport,
                readFile: async () => ca,
            });
            await client.request("GET", "sys/health");
            ca = "second";
            await client.request("GET", "sys/health");
            expect(bao.requests.map((r) => r.ca)).toEqual(["first", "second"]);
        });

        it("refuses to send anything when the CA file can't be read", async () => {
            const bao = fakeOpenBao(() => json(200, {}));
            const client = new OpenBaoClient({
                name: "mail:pki:openbao",
                address: "https://bao:8200",
                caFile: "/missing.pem",
                auth: { method: "token", token: "t" },
                transport: bao.transport,
                readFile: files({}),
            });
            await expect(client.request("GET", "sys/health")).rejects.toMatchObject({ kind: "config", message: expect.stringContaining("/missing.pem") });
            expect(bao.requests).toHaveLength(0);
        });

        it("reports an error answer with OpenBao's own messages and the status, never the token", async () => {
            const bao = fakeOpenBao(() => json(403, { errors: ["permission denied"] }));
            const client = new OpenBaoClient({ name: "mail:pki:openbao", address: "https://bao:8200", auth: { method: "token", token: "s.secret-token" }, transport: bao.transport });

            const error: OpenBaoError = await client.request("POST", "pki/sign/r", {}).catch((err) => err);
            expect(error).toBeInstanceOf(OpenBaoError);
            expect(error.kind).toBe("rejected");
            expect(error.status).toBe(403);
            expect(error.message).toContain("permission denied");
            expect(error.message).toContain("pki/sign/r");
            expect(error.message).not.toContain("s.secret-token");
            // A static token can't log in again, so a 403 is not retried.
            expect(bao.requests).toHaveLength(1);
        });

        it("never repeats a response body that isn't OpenBao's error list (it may carry secret values)", async () => {
            const bao = fakeOpenBao(() => ({ status: 500, body: '{"data":{"apiKey":"leaked-value"}}' }));
            const client = new OpenBaoClient({ name: "x", address: "https://bao:8200", auth: { method: "token", token: "t" }, transport: bao.transport });
            const error: OpenBaoError = await client.request("GET", "secret/data/a").catch((err) => err);
            expect(error.status).toBe(500);
            expect(error.message).not.toContain("leaked-value");
        });

        it("reports no answer at all as unreachable, and an answer that isn't JSON as rejected", async () => {
            const down = new OpenBaoClient({
                name: "x",
                address: "https://bao:8200",
                auth: { method: "token", token: "t" },
                transport: async () => {
                    throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
                },
            });
            await expect(down.request("GET", "sys/health")).rejects.toMatchObject({ kind: "unreachable", message: expect.stringContaining("ECONNREFUSED") });

            const garbled = new OpenBaoClient({ name: "x", address: "https://bao:8200", auth: { method: "token", token: "t" }, transport: async () => ({ status: 200, body: "<html>" }) });
            await expect(garbled.request("GET", "sys/health")).rejects.toMatchObject({ kind: "rejected", status: 200 });
        });
    });

    describe("with Kubernetes auth", () => {
        it("logs in with the projected ServiceAccount token, then uses the token it was given", async () => {
            const bao = fakeOpenBao((request) => (request.url.pathname === "/v1/auth/kubernetes/login" ? login("s.short-lived") : json(200, { ok: true })));
            const client = kubernetesClient({ transport: bao.transport });

            expect(await client.request("POST", "pki/sign/rapidmx", { csr: "CSR" })).toEqual({ ok: true });

            expect(bao.requests).toHaveLength(2);
            const [loginRequest, signRequest] = bao.requests;
            expect(loginRequest.method).toBe("POST");
            expect(loginRequest.url.toString()).toBe("https://openbao.openbao.svc:8200/v1/auth/kubernetes/login");
            expect(JSON.parse(loginRequest.body!)).toEqual({ role: "rapidmx-server", jwt: JWT });
            expect(loginRequest.headers["X-Vault-Token"]).toBeUndefined();
            expect(loginRequest.ca).toBe(CA);
            expect(signRequest.headers["X-Vault-Token"]).toBe("s.short-lived");
            expect(signRequest.ca).toBe(CA);
        });

        it("logs in at the configured auth mount", async () => {
            const bao = fakeOpenBao((request) => (request.url.pathname.endsWith("/login") ? login("s.t") : json(200, {})));
            const client = kubernetesClient({
                transport: bao.transport,
                auth: { method: "kubernetes", role: "r", mountPath: "k3s-cluster", tokenFile: "/var/run/secrets/openbao/token" },
            });
            await client.request("GET", "sys/health");
            expect(bao.requests[0].url.pathname).toBe("/v1/auth/k3s-cluster/login");
        });

        it("keeps its token until two thirds of the lease have passed, then logs in again with the token file as it is then", async () => {
            let now = 1_000_000;
            const tokens = ["s.first", "s.second"];
            const bao = fakeOpenBao((request) => (request.url.pathname.endsWith("/login") ? login(tokens.shift()!, 3600) : json(200, {})));
            let jwt = "jwt-one";
            const client = kubernetesClient({
                transport: bao.transport,
                now: () => now,
                readFile: async (path: string) => (path.endsWith("token") ? jwt : CA),
            });

            await client.request("GET", "a");
            now += 39 * 60 * 1000;
            await client.request("GET", "b");
            expect(bao.requests.filter((r) => r.url.pathname.endsWith("/login"))).toHaveLength(1);

            // The kubelet rotates the projected token; the next login reads the new one.
            jwt = "jwt-two";
            now += 2 * 60 * 1000;
            await client.request("GET", "c");
            const logins = bao.requests.filter((r) => r.url.pathname.endsWith("/login"));
            expect(logins).toHaveLength(2);
            expect(JSON.parse(logins[1].body!).jwt).toBe("jwt-two");
            expect(bao.requests.at(-1)!.headers["X-Vault-Token"]).toBe("s.second");
        });

        it("logs in once for requests made together", async () => {
            const bao = fakeOpenBao(async (request) => {
                if (request.url.pathname.endsWith("/login")) {
                    await new Promise((resolve) => setTimeout(resolve, 5));
                    return login("s.shared");
                }
                return json(200, {});
            });
            const client = kubernetesClient({ transport: bao.transport });
            await Promise.all([client.request("GET", "a"), client.request("GET", "b"), client.request("GET", "c")]);
            expect(bao.requests.filter((r) => r.url.pathname.endsWith("/login"))).toHaveLength(1);
            expect(bao.requests.filter((r) => !r.url.pathname.endsWith("/login")).every((r) => r.headers["X-Vault-Token"] === "s.shared")).toBe(true);
        });

        it("logs in again once and retries when OpenBao no longer takes a token it has held a while", async () => {
            let now = 1_000_000;
            let revoked = false;
            const tokens = ["s.revoked", "s.fresh"];
            const bao = fakeOpenBao((request) => {
                if (request.url.pathname.endsWith("/login")) {
                    return login(tokens.shift()!);
                }
                return revoked && request.headers["X-Vault-Token"] === "s.revoked" ? json(403, { errors: ["permission denied"] }) : json(200, { ok: 1 });
            });
            const client = kubernetesClient({ transport: bao.transport, now: () => now });
            await client.request("GET", "pki/ca/pem");
            now += 5 * 60 * 1000;
            revoked = true;
            expect(await client.request("POST", "pki/revoke", { serial_number: "01" })).toEqual({ ok: 1 });
            expect(bao.requests.map((r) => r.url.pathname)).toEqual([
                "/v1/auth/kubernetes/login",
                "/v1/pki/ca/pem",
                "/v1/pki/revoke",
                "/v1/auth/kubernetes/login",
                "/v1/pki/revoke",
            ]);
        });

        it("gives up after one retry when the fresh token is refused too", async () => {
            let now = 1_000_000;
            let refuse = false;
            const bao = fakeOpenBao((request) =>
                request.url.pathname.endsWith("/login") ? login("s.t") : refuse ? json(403, { errors: ["permission denied"] }) : json(200, { ok: 1 })
            );
            const client = kubernetesClient({ transport: bao.transport, now: () => now });
            await client.request("GET", "secret/data/y");
            now += 5 * 60 * 1000;
            refuse = true;
            await expect(client.request("POST", "secret/data/x", {})).rejects.toMatchObject({ kind: "rejected", status: 403 });
            expect(bao.requests).toHaveLength(5);
        });

        it("answers a refusal of a token it just logged in for as it is (a policy denial), without logging in again", async () => {
            let now = 1_000_000;
            const bao = fakeOpenBao((request) => (request.url.pathname.endsWith("/login") ? login("s.t") : json(403, { errors: ["permission denied"] })));
            const client = kubernetesClient({ transport: bao.transport, now: () => now });
            for (let i = 0; i < 3; i++) {
                await expect(client.request("GET", "secret/data/other/x")).rejects.toMatchObject({ kind: "rejected", status: 403 });
                now += 10 * 1000;
            }
            // One login for all three: each further denial costs OpenBao no new token or lease.
            expect(bao.requests.map((r) => r.url.pathname)).toEqual([
                "/v1/auth/kubernetes/login",
                "/v1/secret/data/other/x",
                "/v1/secret/data/other/x",
                "/v1/secret/data/other/x",
            ]);
        });

        it("reports a refused login with the role and OpenBao's reason, never the ServiceAccount token", async () => {
            const bao = fakeOpenBao(() => json(400, { errors: ["service account name not authorized"] }));
            const client = kubernetesClient({ transport: bao.transport });
            const error: OpenBaoError = await client.request("GET", "a").catch((err) => err);
            expect(error.kind).toBe("rejected");
            expect(error.status).toBe(400);
            expect(error.message).toContain("rapidmx-server");
            expect(error.message).toContain("service account name not authorized");
            expect(error.message).not.toContain(JWT);
            expect(bao.requests).toHaveLength(1);
        });

        it("reports a login answer without a token, or that isn't JSON, as rejected", async () => {
            const bao = fakeOpenBao(() => json(200, { auth: null }));
            const client = kubernetesClient({ transport: bao.transport });
            await expect(client.request("GET", "a")).rejects.toMatchObject({ kind: "rejected", message: expect.stringContaining("no token") });

            const garbled = kubernetesClient({ transport: async () => ({ status: 200, body: "<html>" }) });
            await expect(garbled.request("GET", "a")).rejects.toMatchObject({ kind: "rejected", message: expect.stringContaining("no token") });
        });

        it("refuses to log in without a ServiceAccount token, naming the file", async () => {
            const bao = fakeOpenBao(() => login("s.t"));
            const missing = kubernetesClient({ transport: bao.transport, readFile: files({ "/etc/rapidmx/openbao-ca/ca.crt": CA }) });
            await expect(missing.request("GET", "a")).rejects.toMatchObject({ kind: "config", message: expect.stringContaining("/var/run/secrets/openbao/token") });
            const empty = kubernetesClient({ transport: bao.transport, readFile: files({ "/var/run/secrets/openbao/token": " \n", "/etc/rapidmx/openbao-ca/ca.crt": CA }) });
            await expect(empty.request("GET", "a")).rejects.toMatchObject({ kind: "config" });
            expect(bao.requests).toHaveLength(0);
        });

        it("tries a failed login again on the next request", async () => {
            let fail = true;
            const bao = fakeOpenBao((request) => {
                if (request.url.pathname.endsWith("/login")) {
                    return fail ? json(503, { errors: ["Vault is sealed"] }) : login("s.t");
                }
                return json(200, {});
            });
            const client = kubernetesClient({ transport: bao.transport });
            await expect(client.request("GET", "a")).rejects.toMatchObject({ status: 503 });
            fail = false;
            await expect(client.request("GET", "a")).resolves.toEqual({});
        });

        it("keeps a token with no lease (a non-expiring one) without logging in again", async () => {
            let now = 0;
            const bao = fakeOpenBao((request) => (request.url.pathname.endsWith("/login") ? login("s.forever", 0) : json(200, {})));
            const client = kubernetesClient({ transport: bao.transport, now: () => now });
            await client.request("GET", "a");
            now += 365 * 24 * 3600 * 1000;
            await client.request("GET", "a");
            expect(bao.requests.filter((r) => r.url.pathname.endsWith("/login"))).toHaveLength(1);
        });
    });

    describe("openBaoClientOptions()", () => {
        it("reads a static token by default", () => {
            expect(openBaoClientOptions("mail:pki:openbao", { address: "https://bao:8200", token: "s.t", timeout_ms: 5000 })).toEqual({
                name: "mail:pki:openbao",
                address: "https://bao:8200",
                caFile: undefined,
                timeoutMs: 5000,
                auth: { method: "token", token: "s.t" },
            });
        });

        it("reads Kubernetes auth with its defaults", () => {
            expect(
                openBaoClientOptions("mail:pki:openbao", {
                    address: "https://bao:8200",
                    ca_file: "/etc/rapidmx/openbao-ca/ca.crt",
                    auth: { method: "kubernetes", role: "rapidmx-server" },
                })
            ).toEqual({
                name: "mail:pki:openbao",
                address: "https://bao:8200",
                caFile: "/etc/rapidmx/openbao-ca/ca.crt",
                timeoutMs: undefined,
                auth: { method: "kubernetes", role: "rapidmx-server", mountPath: "kubernetes", tokenFile: DEFAULT_OPENBAO_TOKEN_FILE },
            });
            expect(DEFAULT_OPENBAO_TOKEN_FILE).toBe("/var/run/secrets/openbao/token");
        });

        it("takes a timeout given as text, as an environment variable sets it", () => {
            expect(openBaoClientOptions("x", { address: "https://bao", timeout_ms: "2500" }).timeoutMs).toBe(2500);
            expect(openBaoClientOptions("x", { address: "https://bao", timeout_ms: "soon" }).timeoutMs).toBeUndefined();
        });

        it("refuses Kubernetes auth without a role, and an unknown method", () => {
            expect(() => openBaoClientOptions("mail:pki:openbao", { address: "https://bao", auth: { method: "kubernetes" } })).toThrow(/mail:pki:openbao:auth:role/);
            expect(() => openBaoClientOptions("mail:pki:openbao", { address: "https://bao", auth: { method: "approle" } })).toThrow(
                /mail:pki:openbao:auth:method/
            );
        });
    });

    describe("openBaoClientFromConfig()", () => {
        it("builds a client from the keys under a prefix", async () => {
            const values: Record<string, unknown> = {
                "mail:pki:openbao:address": "https://openbao.openbao.svc:8200",
                "mail:pki:openbao:ca_file": "/ca.pem",
                "mail:pki:openbao:auth:method": "kubernetes",
                "mail:pki:openbao:auth:role": "rapidmx-server",
                "mail:pki:openbao:auth:mount_path": "kubernetes",
                "mail:pki:openbao:auth:token_file": "/jwt",
            };
            const bao = fakeOpenBao((request) => (request.url.pathname.endsWith("/login") ? login("s.t") : json(200, { data: {} })));
            const client = openBaoClientFromConfig({ get: (key: string) => values[key] }, "mail:pki:openbao", {
                transport: bao.transport,
                readFile: files({ "/ca.pem": CA, "/jwt": JWT }),
            });
            await client.request("GET", "secret/data/rapidmx-server/other");
            expect(bao.requests[0].url.toString()).toBe("https://openbao.openbao.svc:8200/v1/auth/kubernetes/login");
            expect(JSON.parse(bao.requests[0].body!)).toEqual({ role: "rapidmx-server", jwt: JWT });
            expect(bao.requests[1].ca).toBe(CA);
        });

        it("refuses a prefix without an address", () => {
            expect(() => openBaoClientFromConfig({ get: () => undefined }, "mail:pki:openbao")).toThrow(/mail:pki:openbao:address/);
        });
    });
});
