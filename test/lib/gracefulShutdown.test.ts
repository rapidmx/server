///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { configMs, drainAndStop } from "../../src/lib/gracefulShutdown.js";
import { isDraining, setDraining } from "../../src/plugins/readiness.js";

describe("drainAndStop", () => {
    afterEach(() => {
        setDraining(false);
        vi.useRealTimers();
    });

    it("reports not ready, waits the drain delay, then stops", async () => {
        const order: string[] = [];
        const sleep = vi.fn(async (ms: number) => {
            order.push(`sleep ${ms} draining=${isDraining()}`);
        });
        const result = await drainAndStop(
            async () => {
                order.push("stop");
            },
            { drainDelayMs: 5_000, timeoutMs: 1_000, sleep },
        );
        expect(result).toBe("stopped");
        expect(order).toEqual(["sleep 5000 draining=true", "stop"]);
    });

    it("skips the wait when the drain delay is 0", async () => {
        const sleep = vi.fn(async () => undefined);
        expect(await drainAndStop(async () => undefined, { drainDelayMs: 0, timeoutMs: 1_000, sleep })).toBe("stopped");
        expect(sleep).not.toHaveBeenCalled();
        expect(isDraining()).toBe(true);
    });

    it("gives up after the timeout when stopping hangs", async () => {
        vi.useFakeTimers();
        const logger = { info: vi.fn(), error: vi.fn() };
        const pending = drainAndStop(() => new Promise<void>(() => undefined), { drainDelayMs: 0, timeoutMs: 25_000, logger });
        await vi.advanceTimersByTimeAsync(25_000);
        expect(await pending).toBe("timeout");
        expect(logger.error).toHaveBeenCalledWith(expect.stringMatching(/longer than 25s/));
    });

    it("reports a stop that throws", async () => {
        const logger = { info: vi.fn(), error: vi.fn() };
        const result = await drainAndStop(async () => {
            throw new Error("db busy");
        }, { drainDelayMs: 0, timeoutMs: 1_000, logger });
        expect(result).toBe("failed");
        expect(logger.error).toHaveBeenCalledWith(expect.stringMatching(/db busy/));
    });
});

describe("configMs", () => {
    it("accepts non-negative numbers (and numeric strings) and falls back otherwise", () => {
        expect(configMs(0, 5)).toBe(0);
        expect(configMs("1500", 5)).toBe(1500);
        expect(configMs(undefined, 5)).toBe(5);
        expect(configMs("", 5)).toBe(5);
        expect(configMs(-1, 5)).toBe(5);
        expect(configMs("abc", 5)).toBe(5);
    });
});
