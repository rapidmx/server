///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
import { EventEmitter } from "node:events";
import http from "node:http";
import https from "node:https";
import { nodeTransport } from "../../src/openbao/OpenBaoClient.js";

/** A stand-in for `request`: `respond(res, req)` plays the server's side once the request is ended. */
function fakeRequest(
    module: typeof http | typeof https,
    respond: (res: EventEmitter & { statusCode?: number }, req: EventEmitter & { destroy: any; written: string[] }) => void
) {
    return vi.spyOn(module, "request").mockImplementation(((_url: any, _options: any, callback: any) => {
        const req: any = new EventEmitter();
        req.written = [];
        req.write = (chunk: string) => req.written.push(chunk);
        req.destroy = vi.fn((err?: Error) => {
            if (err) req.emit("error", err);
        });
        req.end = () => {
            const res: any = new EventEmitter();
            respond(res, req);
            if (callback && res.statusCode !== undefined) callback(res);
        };
        return req;
    }) as any);
}

const answer = (status: number, body: string) => (res: any) => {
    res.statusCode = status;
    queueMicrotask(() => {
        res.emit("data", Buffer.from(body));
        res.emit("end");
    });
};

describe("nodeTransport", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("sends over https with the CA, verifying the peer, and writes the body", async () => {
        const spy = fakeRequest(https, answer(200, '{"ok":true}'));
        const response = await nodeTransport({
            method: "POST",
            url: new URL("https://openbao.openbao.svc:8200/v1/pki/sign/r"),
            headers: { "X-Vault-Token": "t", "Content-Type": "application/json" },
            body: '{"csr":"x"}',
            ca: "CA",
            timeoutMs: 50,
        });
        expect(response).toEqual({ status: 200, body: '{"ok":true}' });
        const options = spy.mock.calls[0][1] as any;
        expect(options).toMatchObject({ method: "POST", ca: "CA", rejectUnauthorized: true, timeout: 50 });
        expect(options.headers["Content-Length"]).toBe(String(Buffer.byteLength('{"csr":"x"}')));
        expect((spy.mock.results[0].value as any).written).toEqual(['{"csr":"x"}']);
    });

    it("sends plain HTTP over http (loopback only; the client refuses anything else)", async () => {
        const httpSpy = fakeRequest(http, answer(204, ""));
        const httpsSpy = vi.spyOn(https, "request");
        expect(await nodeTransport({ method: "DELETE", url: new URL("http://127.0.0.1:8200/v1/a"), headers: {}, timeoutMs: 50 })).toEqual({ status: 204, body: "" });
        expect(httpSpy).toHaveBeenCalledTimes(1);
        expect(httpsSpy).not.toHaveBeenCalled();
        expect((httpSpy.mock.calls[0][1] as any).ca).toBeUndefined();
    });

    it("reports a status of 0 when there is none", async () => {
        fakeRequest(https, (res) => {
            res.statusCode = 0;
            queueMicrotask(() => res.emit("end"));
        });
        expect(await nodeTransport({ method: "GET", url: new URL("https://bao/v1/a"), headers: {}, timeoutMs: 50 })).toEqual({ status: 0, body: "" });
    });

    it("rejects an answer that is too large", async () => {
        fakeRequest(https, (res) => {
            res.statusCode = 200;
            queueMicrotask(() => {
                res.emit("data", Buffer.alloc(5 * 1024 * 1024));
                res.emit("data", Buffer.from("more"));
            });
        });
        await expect(nodeTransport({ method: "GET", url: new URL("https://bao/v1/a"), headers: {}, timeoutMs: 50 })).rejects.toThrow("too large");
    });

    it("rejects a failed response stream, a connection error and a timeout", async () => {
        fakeRequest(https, (res) => {
            res.statusCode = 200;
            queueMicrotask(() => res.emit("error", new Error("reset")));
        });
        await expect(nodeTransport({ method: "GET", url: new URL("https://bao/v1/a"), headers: {}, timeoutMs: 50 })).rejects.toThrow("reset");
        vi.restoreAllMocks();

        fakeRequest(https, (_res, req) => queueMicrotask(() => req.emit("error", new Error("ECONNREFUSED"))));
        await expect(nodeTransport({ method: "GET", url: new URL("https://bao/v1/a"), headers: {}, timeoutMs: 50 })).rejects.toThrow("ECONNREFUSED");
        vi.restoreAllMocks();

        fakeRequest(https, (_res, req) => queueMicrotask(() => req.emit("timeout")));
        await expect(nodeTransport({ method: "GET", url: new URL("https://bao/v1/a"), headers: {}, timeoutMs: 50 })).rejects.toThrow("no answer within 50 ms");
    });
});
