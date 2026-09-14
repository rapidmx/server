///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import * as http from "http";
import * as net from "net";

/**
 * A TCP port on 127.0.0.1 that was free a moment ago. The framework's uWS router can't report the port it actually
 * bound when asked for port 0, so a test server asks the OS for a free port first rather than using a fixed one that
 * may collide with a running `yarn dev` server or another test server.
 */
export function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const probe: net.Server = net.createServer();
        probe.unref();
        probe.once("error", reject);
        probe.listen(0, "127.0.0.1", () => {
            const { port } = probe.address() as net.AddressInfo;
            probe.close(() => resolve(port));
        });
    });
}

/** A minimal HTTP call to a test server on 127.0.0.1 (never `localhost`, which may resolve to ::1 first). */
export function localRequest(
    port: number,
    method: string,
    path: string,
    headers: Record<string, string> = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
    return new Promise((resolve, reject) => {
        const req: http.ClientRequest = http.request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
            let body: string = "";
            res.setEncoding("utf-8");
            res.on("data", (chunk: string) => (body += chunk));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
        });
        req.on("error", reject);
        req.end();
    });
}
