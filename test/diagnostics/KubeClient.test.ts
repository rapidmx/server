///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { KubeClient, KubeError, type KubeRequest, type KubeTransport } from "../../src/diagnostics/KubeClient.js";

describe("KubeClient", () => {
    let dir: string;

    beforeEach(async () => {
        dir = await mkdtemp(path.join(os.tmpdir(), "sa-"));
        await writeFile(path.join(dir, "token"), "tok-1\n");
        await writeFile(path.join(dir, "namespace"), "mail\n");
        await writeFile(path.join(dir, "ca.crt"), "CA-PEM");
    });

    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    function client(transport: KubeTransport, host = "10.43.0.1") {
        return new KubeClient({ host, port: "443", serviceAccountDir: dir, transport, timeoutMs: 1234 });
    }

    describe("detect()", () => {
        it("reports when it is not running in Kubernetes", async () => {
            const result = await KubeClient.detect({ env: {} });
            expect(result.client).toBeUndefined();
            expect(result.reason).toMatch(/not running in Kubernetes/);
        });

        it("reports a pod with no token mounted", async () => {
            const result = await KubeClient.detect({
                env: { KUBERNETES_SERVICE_HOST: "10.0.0.1" },
                serviceAccountDir: path.join(dir, "missing"),
            });
            expect(result.client).toBeUndefined();
            expect(result.reason).toMatch(/no service account token/);
        });

        it("returns a client when the token is there, defaulting the port", async () => {
            const transport = vi.fn().mockResolvedValue({ status: 200, body: "{}" });
            const result = await KubeClient.detect({ env: { KUBERNETES_SERVICE_HOST: "10.0.0.1" }, serviceAccountDir: dir, transport });
            await result.client!.get("/version");
            expect((transport.mock.calls[0][0] as KubeRequest).url.href).toBe("https://10.0.0.1/version");
        });

        it("uses the process environment by default", async () => {
            const before = process.env.KUBERNETES_SERVICE_HOST;
            delete process.env.KUBERNETES_SERVICE_HOST;
            try {
                expect((await KubeClient.detect()).client).toBeUndefined();
            } finally {
                if (before !== undefined) process.env.KUBERNETES_SERVICE_HOST = before;
            }
        });
    });

    it("reads the namespace", async () => {
        expect(await client(vi.fn()).namespace()).toBe("mail");
    });

    it("sends a verified, authenticated JSON GET with the cluster CA", async () => {
        const transport = vi.fn().mockResolvedValue({ status: 200, body: '{"a":1}' });
        expect(await client(transport).get("/api/v1/pods")).toEqual({ a: 1 });
        const request = transport.mock.calls[0][0] as KubeRequest;
        expect(request).toMatchObject({
            headers: { Accept: "application/json", Authorization: "Bearer tok-1" },
            ca: "CA-PEM",
            rejectUnauthorized: true,
            timeoutMs: 1234,
        });
        expect(request.url.href).toBe("https://10.43.0.1/api/v1/pods");
    });

    it("brackets an IPv6 host and re-reads the rotated token every time", async () => {
        const transport = vi.fn().mockResolvedValue({ status: 200, body: "{}" });
        const c = client(transport, "fd00::1");
        await c.get("/version");
        await writeFile(path.join(dir, "token"), "tok-2");
        await c.get("/version");
        expect((transport.mock.calls[0][0] as KubeRequest).url.host).toBe("[fd00::1]");
        expect((transport.mock.calls[1][0] as KubeRequest).headers.Authorization).toBe("Bearer tok-2");
    });

    it("works without a CA file", async () => {
        await rm(path.join(dir, "ca.crt"));
        const transport = vi.fn().mockResolvedValue({ status: 200, body: "{}" });
        await client(transport).get("/version");
        expect((transport.mock.calls[0][0] as KubeRequest).ca).toBeUndefined();
    });

    it("explains a refusal by RBAC", async () => {
        const c = client(vi.fn().mockResolvedValue({ status: 403, body: "{}" }));
        const error = await c.get("/api/v1/pods").catch((e) => e);
        expect(error).toBeInstanceOf(KubeError);
        expect(error.status).toBe(403);
        expect(error.message).toMatch(/HTTP 403.*diagnostics\.rbac\.create/);
    });

    it("reports other statuses plainly", async () => {
        const error = await client(vi.fn().mockResolvedValue({ status: 404, body: "" })).get("/x").catch((e) => e);
        expect(error.message).toMatch(/HTTP 404$/);
    });

    it("reports a connection failure and a non-JSON answer", async () => {
        const refused = await client(vi.fn().mockRejectedValue(Object.assign(new Error("no"), { code: "ECONNREFUSED" })))
            .get("/x")
            .catch((e) => e);
        expect(refused.message).toMatch(/ECONNREFUSED/);
        const plain = await client(vi.fn().mockRejectedValue("boom")).get("/x").catch((e) => e);
        expect(plain.message).toMatch(/boom/);
        const notJson = await client(vi.fn().mockResolvedValue({ status: 200, body: "<html>" })).get("/x").catch((e) => e);
        expect(notJson.message).toMatch(/not JSON/);
    });
});
