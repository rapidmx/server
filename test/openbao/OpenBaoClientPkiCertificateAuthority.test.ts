///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Logger } from "@rapidrest/core";
import { ObjectFactory } from "@rapidrest/service-core";
import { OpenBaoPkiCertificateAuthority } from "@rapidmx/restapi";
import { OpenBaoHttpRequest, OpenBaoHttpResponse, OpenBaoTransport, nodeTransport } from "../../src/openbao/OpenBaoClient.js";
import { OpenBaoClientPkiCertificateAuthority } from "../../src/openbao/OpenBaoClientPkiCertificateAuthority.js";

/** A CSR for alice@example.com, a certificate for it (good) and one naming someone else for the same key (bad), from one test CA. */
const fixtures: { csr: string; ca: string; good: string; bad: string; goodFp: string } = JSON.parse(
    readFileSync(path.join(__dirname, "../fixtures/openbao/pki.json"), "utf8")
);
const JWT = "projected.service-account.jwt";

/** restapi's PKI CA over the server's client, its transport and files replaced by fakes. */
class TestCa extends OpenBaoClientPkiCertificateAuthority {
    requests: OpenBaoHttpRequest[] = [];
    answer: (request: OpenBaoHttpRequest) => OpenBaoHttpResponse | Promise<OpenBaoHttpResponse> = () => ({ status: 500, body: "{}" });
    files: Record<string, string> = { "/var/run/secrets/openbao/token": JWT, "/etc/rapidmx/openbao-ca/ca.crt": "CA PEM" };

    protected override openBaoTransport(): OpenBaoTransport {
        return async (request) => {
            this.requests.push(request);
            return this.answer(request);
        };
    }

    protected override async readTextFile(file: string): Promise<string> {
        if (!(file in this.files)) {
            throw new Error(`ENOENT: ${file}`);
        }
        return this.files[file];
    }
}

const json = (status: number, body: unknown): OpenBaoHttpResponse => ({ status, body: JSON.stringify(body) });

let dir: string;

/** A CA configured the way the chart configures it, through the real ObjectFactory and these settings. */
async function newCa(settings: Record<string, unknown> = {}): Promise<TestCa> {
    const values: Record<string, unknown> = {
        "mail:pki:openbao:address": "https://openbao.openbao.svc:8200",
        "mail:pki:openbao:mount": "pki",
        "mail:pki:openbao:role": "rapidmx-encryption",
        "mail:pki:openbao:ca_file": "/etc/rapidmx/openbao-ca/ca.crt",
        "mail:pki:openbao:auth:method": "kubernetes",
        "mail:pki:openbao:auth:role": "rapidmx-server",
        "mail:pki:openbao:serial_map_path": path.join(dir, "serials.json"),
        ...settings,
    };
    const factory = new ObjectFactory({ get: (key: string) => values[key] } as any, Logger());
    const ca = new TestCa();
    await factory.initialize(ca);
    return ca;
}

describe("OpenBaoClientPkiCertificateAuthority", () => {
    beforeEach(async () => {
        dir = await mkdtemp(path.join(os.tmpdir(), "openbao-pki-"));
    });

    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
        vi.unstubAllGlobals();
    });

    it("is restapi's OpenBao PKI CA, so its own checks of what OpenBao issues still apply", () => {
        expect(new TestCa()).toBeInstanceOf(OpenBaoPkiCertificateAuthority);
        expect(new TestCa().name).toBe("openbao-pki");
    });

    it("signs through OpenBao after logging in with the ServiceAccount token, verifying the peer with the configured CA", async () => {
        const fetchSpy = vi.fn();
        vi.stubGlobal("fetch", fetchSpy);
        const ca = await newCa();
        ca.answer = (request) =>
            request.url.pathname === "/v1/auth/kubernetes/login"
                ? json(200, { auth: { client_token: "s.server", lease_duration: 3600 } })
                : json(200, { data: { certificate: fixtures.good, serial_number: "1a:2b", issuing_ca: fixtures.ca } });

        const issued = await ca.issue("alice@example.com", fixtures.csr);

        expect(issued).toMatchObject({ certificate: fixtures.good, serialNumber: "1a:2b", fingerprint: fixtures.goodFp, issuerCertificate: fixtures.ca });
        expect(ca.requests.map((r) => `${r.method} ${r.url}`)).toEqual([
            "POST https://openbao.openbao.svc:8200/v1/auth/kubernetes/login",
            "POST https://openbao.openbao.svc:8200/v1/pki/sign/rapidmx-encryption",
        ]);
        expect(JSON.parse(ca.requests[0].body!)).toEqual({ role: "rapidmx-server", jwt: JWT });
        expect(JSON.parse(ca.requests[1].body!)).toEqual({ csr: fixtures.csr, common_name: "alice@example.com" });
        expect(ca.requests[1].headers["X-Vault-Token"]).toBe("s.server");
        expect(ca.requests.every((r) => r.ca === "CA PEM")).toBe(true);
        // Nothing goes through the global fetch, which can't take a CA of its own.
        expect(fetchSpy).not.toHaveBeenCalled();
        // restapi's bookkeeping still runs: revoke() finds the serial by fingerprint.
        expect(JSON.parse(await readFile(path.join(dir, "serials.json"), "utf8"))).toEqual({ [fixtures.goodFp]: "1a:2b" });
    });

    it("revokes through OpenBao, and revokes a certificate that doesn't match the request through it too", async () => {
        const ca = await newCa();
        ca.answer = (request) => {
            if (request.url.pathname.endsWith("/login")) {
                return json(200, { auth: { client_token: "s.server", lease_duration: 3600 } });
            }
            if (request.url.pathname.endsWith("/sign/rapidmx-encryption")) {
                return json(200, { data: { certificate: fixtures.bad, serial_number: "3c:4d" } });
            }
            return { status: 204, body: "" };
        };

        await expect(ca.issue("alice@example.com", fixtures.csr)).rejects.toMatchObject({ status: 502, message: expect.stringContaining("does not match") });
        expect(ca.requests.at(-1)!.url.pathname).toBe("/v1/pki/revoke");
        expect(JSON.parse(ca.requests.at(-1)!.body)).toEqual({ serial_number: "3c:4d" });

        await writeFile(path.join(dir, "serials.json"), JSON.stringify({ abc: "0f:0e" }));
        await ca.revoke("abc");
        expect(ca.requests.at(-1)!.url.pathname).toBe("/v1/pki/revoke");
        expect(JSON.parse(ca.requests.at(-1)!.body)).toEqual({ serial_number: "0f:0e" });
        // One login served every call.
        expect(ca.requests.filter((r) => r.url.pathname.endsWith("/login"))).toHaveLength(1);
    });

    it("still takes a static token (docker-compose.openbao.yml, or a vault prepared by hand)", async () => {
        const ca = await newCa({
            "mail:pki:openbao:address": "http://127.0.0.1:8200",
            "mail:pki:openbao:ca_file": "",
            "mail:pki:openbao:auth:method": undefined,
            "mail:pki:openbao:auth:role": undefined,
            "mail:pki:openbao:token": "s.static",
        });
        ca.answer = () => ({ status: 204, body: "" });
        await writeFile(path.join(dir, "serials.json"), JSON.stringify({ abc: "01" }));
        await ca.revoke("abc");
        expect(ca.requests).toHaveLength(1);
        expect(ca.requests[0].url.toString()).toBe("http://127.0.0.1:8200/v1/pki/revoke");
        expect(ca.requests[0].headers["X-Vault-Token"]).toBe("s.static");
        expect(ca.requests[0].ca).toBeUndefined();
    });

    it("answers 502 when OpenBao refuses or can't be reached, as restapi's CA does, without the token in the log", async () => {
        const ca = await newCa();
        const logged: string[] = [];
        (ca as any).log = { error: (message: string) => logged.push(message), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
        await writeFile(path.join(dir, "serials.json"), JSON.stringify({ abc: "01" }));

        ca.answer = (request) =>
            request.url.pathname.endsWith("/login") ? json(200, { auth: { client_token: "s.server", lease_duration: 3600 } }) : json(400, { errors: ["unknown serial"] });
        await expect(ca.revoke("abc")).rejects.toMatchObject({ status: 502, message: "The configured PKI server rejected the request." });

        ca.answer = () => {
            throw new Error("connect ECONNREFUSED");
        };
        const down = await newCa();
        (down as any).log = { error: (message: string) => logged.push(message) };
        down.answer = ca.answer;
        await expect(down.revoke("abc")).rejects.toMatchObject({ status: 502, message: "The configured PKI server could not be reached." });

        expect(logged.some((line) => line.includes("unknown serial"))).toBe(true);
        expect(logged.some((line) => line.includes("ECONNREFUSED"))).toBe(true);
        expect(logged.join("\n")).not.toContain("s.server");
        expect(logged.join("\n")).not.toContain(JWT);
    });

    it("answers 500 for settings that can't work, sending nothing", async () => {
        await writeFile(path.join(dir, "serials.json"), JSON.stringify({ abc: "01" }));
        const plain = await newCa({ "mail:pki:openbao:address": "http://openbao.openbao.svc:8200" });
        await expect(plain.revoke("abc")).rejects.toMatchObject({ status: 500, message: expect.stringContaining("https://") });
        const noRole = await newCa({ "mail:pki:openbao:auth:role": "" });
        await expect(noRole.revoke("abc")).rejects.toMatchObject({ status: 500, message: expect.stringContaining("mail:pki:openbao:auth:role") });
        expect(plain.requests).toHaveLength(0);
        expect(noRole.requests).toHaveLength(0);
    });

    it("sends over node's https and reads its files from disk unless replaced", async () => {
        const ca: any = new OpenBaoClientPkiCertificateAuthority();
        expect(ca.openBaoTransport()).toBe(nodeTransport);
        const file = path.join(dir, "ca.crt");
        await writeFile(file, "CA PEM");
        expect(await ca.readTextFile(file)).toBe("CA PEM");
    });

    it("refuses to start when restapi's CA no longer sends its requests through the method this replaces", () => {
        const prototype = OpenBaoPkiCertificateAuthority.prototype as any;
        const original = prototype.request;
        delete prototype.request;
        try {
            expect(() => new TestCa()).toThrow(/request/);
        } finally {
            prototype.request = original;
        }
    });
});
