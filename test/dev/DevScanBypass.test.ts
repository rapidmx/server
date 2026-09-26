///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
import * as http from "http";
import * as net from "net";
import { AvVerdict, SpamVerdict } from "@rapidmx/restapi";
import { ClamAvScanProvider, RspamdSpamScanProvider } from "@rapidmx/restapi/scan";
import {
    DEV_SCANNING_STACK_COMMAND,
    DevBypassAvScanProvider,
    DevBypassSpamScanProvider,
    isEngineUnreachableError,
    probeScanEngine,
} from "../../src/dev/DevScanBypass.js";

const RAW = Buffer.from("From: a@example.com\r\nTo: b@example.com\r\nSubject: hi\r\n\r\nhello\r\n");
const ENVELOPE = { from: "a@example.com", to: ["b@example.com"] };

/** A port nothing is listening on (bound and released again). */
async function closedPort(): Promise<number> {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return port;
}

/** Listens on `port` (0 for any), answering each connection with `onConnection`. */
async function listen(port: number, onConnection: (socket: net.Socket) => void = (s) => s.end()): Promise<net.Server> {
    const server = net.createServer(onConnection);
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
    return server;
}

function portOf(server: net.Server | http.Server): number {
    return (server.address() as net.AddressInfo).port;
}

function close(server: net.Server | http.Server): Promise<void> {
    return new Promise((resolve) => server.close(() => resolve()));
}

function fakeLogger(): { warn: ReturnType<typeof vi.fn>; debug: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> } {
    return { warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
}

function avWrapper(port: number, inner: any): { provider: DevBypassAvScanProvider; logger: ReturnType<typeof fakeLogger>; clock: { t: number } } {
    const provider = new DevBypassAvScanProvider();
    const logger = fakeLogger();
    const clock = { t: 1_000_000 };
    Object.assign(provider as any, { inner, host: "127.0.0.1", port, logger });
    provider.now = () => clock.t;
    return { provider, logger, clock };
}

function spamWrapper(url: string, inner: any): { provider: DevBypassSpamScanProvider; logger: ReturnType<typeof fakeLogger>; clock: { t: number } } {
    const provider = new DevBypassSpamScanProvider();
    const logger = fakeLogger();
    const clock = { t: 1_000_000 };
    Object.assign(provider as any, { inner, url, logger });
    provider.now = () => clock.t;
    return { provider, logger, clock };
}

describe("isEngineUnreachableError", () => {
    it("accepts connection failures by code, including one wrapped as a fetch() cause", () => {
        for (const code of ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "EADDRNOTAVAIL", "ETIMEDOUT"]) {
            expect(isEngineUnreachableError({ code })).toBe(true);
            expect(isEngineUnreachableError(Object.assign(new TypeError("fetch failed"), { cause: { code } }))).toBe(true);
        }
    });

    it("rejects errors that aren't a failure to connect", () => {
        expect(isEngineUnreachableError({ code: "ECONNRESET" })).toBe(false);
        expect(isEngineUnreachableError({ code: "EPROTO" })).toBe(false);
        expect(isEngineUnreachableError(new Error("rspamd returned HTTP 500"))).toBe(false);
        expect(isEngineUnreachableError(undefined)).toBe(false);
    });
});

describe("probeScanEngine", () => {
    it("reports a listening engine as reachable", async () => {
        const server = await listen(0);
        try {
            expect(await probeScanEngine("127.0.0.1", portOf(server), 2_000)).toEqual({ reachable: true });
        } finally {
            await close(server);
        }
    });

    it("reports a refused connection as unreachable", async () => {
        const port = await closedPort();
        const probe = await probeScanEngine("127.0.0.1", port, 2_000);
        expect(probe.reachable).toBe(false);
        expect((probe as any).reason).toContain("ECONNREFUSED");
    });

    it("reports a host name that doesn't resolve as unreachable", async () => {
        const probe = await probeScanEngine("rapidmx-no-such-scan-engine.invalid", 3310, 10_000);
        expect(probe.reachable).toBe(false);
    });

    it("reports a connection that doesn't complete in time as unreachable", async () => {
        // A non-routable address: depending on the network this times out or fails with EHOSTUNREACH/ENETUNREACH.
        const probe = await probeScanEngine("10.255.255.1", 3310, 50);
        expect(probe.reachable).toBe(false);
    });

    it("rejects on any other connection error", async () => {
        await expect(probeScanEngine("127.0.0.1", -1, 2_000)).rejects.toThrow();
    });
});

describe("DevBypassAvScanProvider", () => {
    it("returns a reachable engine's verdicts unchanged without probing or warning", async () => {
        const port = await closedPort();
        const infected = { verdict: AvVerdict.INFECTED, signatureName: "Eicar-Test-Signature" };
        const clean = { verdict: AvVerdict.CLEAN };
        const inner = { name: "clamav", scanBuffer: vi.fn().mockResolvedValueOnce(infected).mockResolvedValueOnce(clean) };
        const { provider, logger } = avWrapper(port, inner);

        expect(await provider.scanBuffer(RAW, "a.txt")).toBe(infected);
        expect(await provider.scanBuffer(RAW)).toBe(clean);
        expect(inner.scanBuffer).toHaveBeenNthCalledWith(1, RAW, "a.txt");
        expect(logger.warn).not.toHaveBeenCalled();
        expect(provider.name).toBe("clamav");
    });

    it("keeps the fail-closed ERROR when the engine is reachable (a protocol error after connecting)", async () => {
        const server = await listen(0);
        try {
            const inner = { name: "clamav", scanBuffer: vi.fn().mockResolvedValue({ verdict: AvVerdict.ERROR }) };
            const { provider, logger } = avWrapper(portOf(server), inner);

            expect(await provider.scanBuffer(RAW)).toEqual({ verdict: AvVerdict.ERROR });
            expect(await provider.scanBuffer(RAW)).toEqual({ verdict: AvVerdict.ERROR });
            expect(inner.scanBuffer).toHaveBeenCalledTimes(2);
            expect(logger.warn).not.toHaveBeenCalled();
        } finally {
            await close(server);
        }
    });

    it("treats an unreachable engine as clean, warning once and then at most every warnIntervalMs", async () => {
        const port = await closedPort();
        const inner = { name: "clamav", scanBuffer: vi.fn().mockResolvedValue({ verdict: AvVerdict.ERROR }) };
        const { provider, logger, clock } = avWrapper(port, inner);

        expect(await provider.scanBuffer(RAW)).toEqual({ verdict: AvVerdict.CLEAN });
        expect(logger.warn).toHaveBeenCalledTimes(1);
        const warning: string = logger.warn.mock.calls[0][0];
        expect(warning).toContain("[dev] ClamAV");
        expect(warning).toContain(`127.0.0.1:${port}`);
        expect(warning).toContain("ECONNREFUSED");
        expect(warning).toContain("bypassed");
        expect(warning).toContain(DEV_SCANNING_STACK_COMMAND);

        // Within recheckMs: bypassed without calling the engine, and no new warning.
        clock.t += 1_000;
        expect(await provider.scanBuffer(RAW)).toEqual({ verdict: AvVerdict.CLEAN });
        expect(await provider.scanBuffer(RAW, "attachment.pdf")).toEqual({ verdict: AvVerdict.CLEAN });
        expect(inner.scanBuffer).toHaveBeenCalledTimes(1);

        // Past recheckMs: probed again, still unreachable, still bypassed without calling the engine or warning.
        clock.t += provider.recheckMs;
        expect(await provider.scanBuffer(RAW)).toEqual({ verdict: AvVerdict.CLEAN });
        expect(inner.scanBuffer).toHaveBeenCalledTimes(1);
        expect(logger.warn).toHaveBeenCalledTimes(1);

        // Past warnIntervalMs: warned again, with the number of scans bypassed in between.
        clock.t += provider.warnIntervalMs;
        expect(await provider.scanBuffer(RAW)).toEqual({ verdict: AvVerdict.CLEAN });
        expect(logger.warn).toHaveBeenCalledTimes(2);
        expect(logger.warn.mock.calls[1][0]).toContain("(4 scans bypassed since the last warning)");
        expect(inner.scanBuffer).toHaveBeenCalledTimes(1);
    });

    it("uses the engine again once it's reachable, and warns afresh on a later outage", async () => {
        const port = await closedPort();
        const inner = { name: "clamav", scanBuffer: vi.fn().mockResolvedValue({ verdict: AvVerdict.ERROR }) };
        const { provider, logger, clock } = avWrapper(port, inner);

        expect(await provider.scanBuffer(RAW)).toEqual({ verdict: AvVerdict.CLEAN });

        const server = await listen(port);
        try {
            inner.scanBuffer.mockResolvedValueOnce({ verdict: AvVerdict.INFECTED, signatureName: "Sig" });
            clock.t += provider.recheckMs;
            expect(await provider.scanBuffer(RAW)).toEqual({ verdict: AvVerdict.INFECTED, signatureName: "Sig" });
            expect(inner.scanBuffer).toHaveBeenCalledTimes(2);
            expect(logger.warn.mock.calls[1][0]).toContain("reachable again");
        } finally {
            await close(server);
        }

        clock.t += 1_000;
        expect(await provider.scanBuffer(RAW)).toEqual({ verdict: AvVerdict.CLEAN });
        expect(logger.warn).toHaveBeenCalledTimes(3);
        expect(logger.warn.mock.calls[2][0]).toContain("is unreachable");
    });

    it("lets an error thrown by the real provider propagate", async () => {
        const port = await closedPort();
        const inner = { name: "clamav", scanBuffer: vi.fn().mockRejectedValue(new Error("boom")) };
        const { provider, logger } = avWrapper(port, inner);

        await expect(provider.scanBuffer(RAW)).rejects.toThrow("boom");
        expect(logger.warn).not.toHaveBeenCalled();
    });

    it("keeps the fail-closed ERROR when the probe fails for a reason other than an outage", async () => {
        const inner = { name: "clamav", scanBuffer: vi.fn().mockResolvedValue({ verdict: AvVerdict.ERROR }) };
        const { provider, logger } = avWrapper(-1, inner);

        expect(await provider.scanBuffer(RAW)).toEqual({ verdict: AvVerdict.ERROR });
        expect(logger.warn).not.toHaveBeenCalled();
        expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining("failed without an outage"));
    });

    it("throws when it has no provider to wrap", async () => {
        const { provider } = avWrapper(3310, undefined);
        await expect(provider.scanBuffer(RAW)).rejects.toThrow("ClamAvScanProvider");
    });

    describe("wrapping the real ClamAvScanProvider", () => {
        function realInner(port: number): ClamAvScanProvider {
            const inner = new ClamAvScanProvider();
            Object.assign(inner as any, { host: "127.0.0.1", port, timeoutMs: 2_000, logger: fakeLogger() });
            return inner;
        }

        it("returns clean when clamd isn't running", async () => {
            const port = await closedPort();
            const { provider, logger } = avWrapper(port, realInner(port));

            expect(await provider.scanBuffer(RAW)).toEqual({ verdict: AvVerdict.CLEAN });
            expect(logger.warn).toHaveBeenCalledTimes(1);
        });

        it("returns a running clamd's INFECTED verdict", async () => {
            const server = await listen(0, (socket) => {
                socket.once("data", () => socket.end("stream: Eicar-Test-Signature FOUND\0"));
            });
            try {
                const { provider, logger } = avWrapper(portOf(server), realInner(portOf(server)));
                expect(await provider.scanBuffer(RAW)).toEqual({ verdict: AvVerdict.INFECTED, signatureName: "Eicar-Test-Signature" });
                expect(logger.warn).not.toHaveBeenCalled();
            } finally {
                await close(server);
            }
        });

        it("keeps ERROR for a running clamd that answers with garbage", async () => {
            const server = await listen(0, (socket) => {
                socket.once("data", () => socket.end("INSTREAM size limit exceeded. ERROR\0"));
            });
            try {
                const { provider, logger } = avWrapper(portOf(server), realInner(portOf(server)));
                expect(await provider.scanBuffer(RAW)).toEqual({ verdict: AvVerdict.ERROR });
                expect(logger.warn).not.toHaveBeenCalled();
            } finally {
                await close(server);
            }
        });
    });
});

describe("DevBypassSpamScanProvider", () => {
    const outage = { score: 0, verdict: SpamVerdict.SUSPECT, symbols: ["SCAN_ENGINE_UNAVAILABLE"] };

    it("returns a reachable engine's verdicts unchanged, including a real SUSPECT verdict", async () => {
        const port = await closedPort();
        const spam = { score: 20, verdict: SpamVerdict.SPAM, symbols: ["BAYES_SPAM"] };
        const greylisted = { score: 5, verdict: SpamVerdict.SUSPECT, symbols: ["GREYLIST"] };
        const inner = { name: "rspamd", scoreMessage: vi.fn().mockResolvedValueOnce(spam).mockResolvedValueOnce(greylisted) };
        const { provider, logger } = spamWrapper(`http://127.0.0.1:${port}`, inner);

        expect(await provider.scoreMessage(RAW, ENVELOPE)).toBe(spam);
        expect(await provider.scoreMessage(RAW, ENVELOPE)).toBe(greylisted);
        expect(inner.scoreMessage).toHaveBeenCalledWith(RAW, ENVELOPE);
        expect(logger.warn).not.toHaveBeenCalled();
        expect(provider.name).toBe("rspamd");
    });

    it("treats an unreachable engine as not spam, with one warning", async () => {
        const port = await closedPort();
        const inner = { name: "rspamd", scoreMessage: vi.fn().mockResolvedValue(outage) };
        const { provider, logger } = spamWrapper(`http://127.0.0.1:${port}`, inner);

        const bypassed = { score: 0, verdict: SpamVerdict.CLEAN, symbols: ["DEV_SCAN_BYPASSED"] };
        expect(await provider.scoreMessage(RAW, ENVELOPE)).toEqual(bypassed);
        expect(await provider.scoreMessage(RAW, ENVELOPE)).toEqual(bypassed);
        expect(inner.scoreMessage).toHaveBeenCalledTimes(1);
        expect(logger.warn).toHaveBeenCalledTimes(1);
        expect(logger.warn.mock.calls[0][0]).toContain("[dev] rspamd");
        expect(logger.warn.mock.calls[0][0]).toContain(DEV_SCANNING_STACK_COMMAND);
    });

    it("lets an error thrown by the real provider propagate", async () => {
        const inner = { name: "rspamd", scoreMessage: vi.fn().mockRejectedValue(new Error("boom")) };
        const { provider } = spamWrapper("http://127.0.0.1:11333", inner);
        await expect(provider.scoreMessage(RAW, ENVELOPE)).rejects.toThrow("boom");
    });

    it("throws when it has no provider to wrap", async () => {
        const { provider } = spamWrapper("http://127.0.0.1:11333", undefined);
        await expect(provider.scoreMessage(RAW, ENVELOPE)).rejects.toThrow("RspamdSpamScanProvider");
    });

    describe("learn", () => {
        const refused = () =>
            Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED", message: "connect ECONNREFUSED 127.0.0.1:11334" } });

        it("forwards a lesson to the real provider, with the reporting mailbox, without warning", async () => {
            const inner = { name: "rspamd", scoreMessage: vi.fn(), learn: vi.fn().mockResolvedValue(undefined) };
            const { provider, logger } = spamWrapper("http://127.0.0.1:11333", inner);

            await expect(provider.learn(RAW, "spam", { recipient: "b@example.com" })).resolves.toBeUndefined();
            await expect(provider.learn(RAW, "ham")).resolves.toBeUndefined();
            expect(inner.learn).toHaveBeenNthCalledWith(1, RAW, "spam", { recipient: "b@example.com" });
            expect(inner.learn).toHaveBeenNthCalledWith(2, RAW, "ham", {});
            expect(logger.warn).not.toHaveBeenCalled();
        });

        it("counts a lesson for a controller that can't be connected to as learned, warning once and then at most every warnIntervalMs", async () => {
            const inner = { name: "rspamd", scoreMessage: vi.fn(), learn: vi.fn().mockRejectedValue(refused()) };
            const { provider, logger, clock } = spamWrapper("http://127.0.0.1:11333", inner);

            await expect(provider.learn(RAW, "spam")).resolves.toBeUndefined();
            await expect(provider.learn(RAW, "ham")).resolves.toBeUndefined();
            expect(inner.learn).toHaveBeenCalledTimes(2);
            expect(logger.warn).toHaveBeenCalledTimes(1);
            expect(logger.warn.mock.calls[0][0]).toContain("[dev] rspamd's controller is unreachable");
            expect(logger.warn.mock.calls[0][0]).toContain("ECONNREFUSED");
            expect(logger.warn.mock.calls[0][0]).toContain(DEV_SCANNING_STACK_COMMAND);

            clock.t += provider.warnIntervalMs;
            await provider.learn(RAW, "spam");
            expect(logger.warn).toHaveBeenCalledTimes(2);
            expect(logger.warn.mock.calls[1][0]).toContain("2 lessons dropped since the last warning");
        });

        it("lets any other failure propagate, so a report says the lesson failed", async () => {
            for (const err of [new Error("rspamd controller returned HTTP 403"), Object.assign(new Error("aborted"), { name: "AbortError" })]) {
                const inner = { name: "rspamd", scoreMessage: vi.fn(), learn: vi.fn().mockRejectedValue(err) };
                const { provider, logger } = spamWrapper("http://127.0.0.1:11333", inner);
                await expect(provider.learn(RAW, "spam")).rejects.toBe(err);
                expect(logger.warn).not.toHaveBeenCalled();
            }
        });

        it("rejects when the real provider can't learn, and when it has no provider to wrap", async () => {
            const { provider } = spamWrapper("http://127.0.0.1:11333", { name: "rspamd", scoreMessage: vi.fn() });
            await expect(provider.learn(RAW, "spam")).rejects.toThrow("cannot learn");
            const none = spamWrapper("http://127.0.0.1:11333", undefined).provider;
            await expect(none.learn(RAW, "spam")).rejects.toThrow("RspamdSpamScanProvider");
        });
    });

    it("probes the host and port of the configured URL", () => {
        const address = (url: string) => (spamWrapper(url, {}).provider as any).engineAddress();
        expect(address("http://localhost:11333")).toEqual({ host: "localhost", port: 11333 });
        expect(address("http://rspamd.internal")).toEqual({ host: "rspamd.internal", port: 80 });
        expect(address("https://rspamd.internal/")).toEqual({ host: "rspamd.internal", port: 443 });
        expect(address("http://[::1]:11333")).toEqual({ host: "::1", port: 11333 });
    });

    describe("wrapping the real RspamdSpamScanProvider", () => {
        function realInner(url: string): RspamdSpamScanProvider {
            const inner = new RspamdSpamScanProvider();
            Object.assign(inner as any, { url, timeoutMs: 2_000, logger: fakeLogger() });
            return inner;
        }

        async function httpServer(handler: http.RequestListener): Promise<http.Server> {
            const server = http.createServer(handler);
            await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
            return server;
        }

        it("returns not spam when rspamd isn't running", async () => {
            const url = `http://127.0.0.1:${await closedPort()}`;
            const { provider, logger } = spamWrapper(url, realInner(url));

            expect(await provider.scoreMessage(RAW, ENVELOPE)).toEqual({ score: 0, verdict: SpamVerdict.CLEAN, symbols: ["DEV_SCAN_BYPASSED"] });
            expect(logger.warn).toHaveBeenCalledTimes(1);
        });

        it("returns a running rspamd's verdict", async () => {
            const server = await httpServer((_req, res) => {
                res.setHeader("content-type", "application/json");
                res.end(JSON.stringify({ action: "reject", score: 25, symbols: { BAYES_SPAM: {} } }));
            });
            try {
                const url = `http://127.0.0.1:${portOf(server)}`;
                const { provider, logger } = spamWrapper(url, realInner(url));
                expect(await provider.scoreMessage(RAW, ENVELOPE)).toEqual({ score: 25, verdict: SpamVerdict.SPAM, symbols: ["BAYES_SPAM"] });
                expect(logger.warn).not.toHaveBeenCalled();
            } finally {
                await close(server);
            }
        });

        it("keeps the fail-closed SUSPECT for a running rspamd that returns an HTTP error", async () => {
            const server = await httpServer((_req, res) => {
                res.statusCode = 500;
                res.end();
            });
            try {
                const url = `http://127.0.0.1:${portOf(server)}`;
                const { provider, logger } = spamWrapper(url, realInner(url));
                expect(await provider.scoreMessage(RAW, ENVELOPE)).toEqual(outage);
                expect(logger.warn).not.toHaveBeenCalled();
            } finally {
                await close(server);
            }
        });
    });
});
