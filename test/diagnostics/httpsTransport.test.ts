///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
import { EventEmitter } from "node:events";
import https from "node:https";
import { httpsTransport } from "../../src/diagnostics/KubeClient.js";

/** A stand-in for `https.request`: `respond(res, req)` plays the server's side once the request is ended. */
function fakeRequest(respond: (res: EventEmitter & { statusCode?: number }, req: EventEmitter & { destroy: any }) => void) {
    return vi.spyOn(https, "request").mockImplementation(((_url: any, _options: any, callback: any) => {
        const req: any = new EventEmitter();
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

const request = {
    url: new URL("https://10.0.0.1:443/version"),
    headers: { Authorization: "Bearer t" },
    ca: "CA",
    rejectUnauthorized: true,
    timeoutMs: 50,
};

describe("httpsTransport", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("collects the body and the status, passing the request's TLS options through", async () => {
        const spy = fakeRequest((res) => {
            res.statusCode = 200;
            queueMicrotask(() => {
                res.emit("data", Buffer.from('{"a"'));
                res.emit("data", Buffer.from(":1}"));
                res.emit("end");
            });
        });
        expect(await httpsTransport(request)).toEqual({ status: 200, body: '{"a":1}' });
        expect(spy.mock.calls[0][1]).toMatchObject({ method: "GET", ca: "CA", rejectUnauthorized: true, timeout: 50, headers: request.headers });
    });

    it("reports a status of 0 when there is none", async () => {
        fakeRequest((res) => {
            res.statusCode = 0;
            queueMicrotask(() => res.emit("end"));
        });
        expect(await httpsTransport(request)).toEqual({ status: 0, body: "" });
    });

    it("rejects when the response stream fails", async () => {
        fakeRequest((res) => {
            res.statusCode = 200;
            queueMicrotask(() => res.emit("error", new Error("reset")));
        });
        await expect(httpsTransport(request)).rejects.toThrow("reset");
    });

    it("rejects an answer that is too large", async () => {
        fakeRequest((res) => {
            res.statusCode = 200;
            queueMicrotask(() => {
                res.emit("data", Buffer.alloc(33 * 1024 * 1024));
                res.emit("data", Buffer.from("more"));
            });
        });
        await expect(httpsTransport(request)).rejects.toThrow("too large");
    });

    it("rejects a connection error and a timeout", async () => {
        fakeRequest((_res, req) => queueMicrotask(() => req.emit("error", new Error("ECONNREFUSED"))));
        await expect(httpsTransport(request)).rejects.toThrow("ECONNREFUSED");

        vi.restoreAllMocks();
        fakeRequest((_res, req) => queueMicrotask(() => req.emit("timeout")));
        await expect(httpsTransport(request)).rejects.toThrow("no answer within 50 ms");
    });
});
