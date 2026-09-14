///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { computePluginStateHash, PLUGIN_CHANGED_EVENT, PLUGIN_EVENTS_CHANNEL, PLUGIN_STATUS_KEY, PLUGIN_STATUS_MAX_AGE_MS } from "@rapidmx/restapi";
import { PLUGIN_RESTART_LOCK_KEY, PLUGIN_ROLLOUT_HALT_KEY, PluginRestartLock, PluginWatcher, type WatcherRedisClient } from "../../src/plugins/PluginWatcher.js";
import { isDraining, setDraining } from "../../src/plugins/readiness.js";

/** A shared in-memory Redis for the watcher's cache and subscriber clients. */
class FakeRedis {
    public values: Map<string, string> = new Map();
    /** The last expiry set on each key, in ms. */
    public ttls: Map<string, number> = new Map();
    public hashes: Map<string, Map<string, string>> = new Map();
    public listeners: ((message: string) => void)[] = [];
    public errorListeners: ((err: Error) => void)[] = [];
    public failConnect: boolean = false;

    public client(): WatcherRedisClient & { quit: any; on: any } {
        return {
            connect: vi.fn(async () => {
                if (this.failConnect) {
                    throw new Error("connection refused");
                }
            }),
            quit: vi.fn(async () => undefined),
            on: vi.fn((event: string, listener: (err: Error) => void) => {
                expect(event).toBe("error");
                this.errorListeners.push(listener);
            }),
            subscribe: vi.fn(async (channel: string, listener: (message: string) => void) => {
                expect(channel).toBe(PLUGIN_EVENTS_CHANNEL);
                this.listeners.push(listener);
            }),
            set: vi.fn(async (key: string, value: string, options: { NX?: true; PX: number }) => {
                if (options?.NX && this.values.has(key)) {
                    return null;
                }
                this.values.set(key, value);
                this.ttls.set(key, options?.PX);
                return "OK";
            }),
            get: vi.fn(async (key: string) => this.values.get(key) ?? null),
            del: vi.fn(async (key: string) => (this.values.delete(key) ? 1 : 0)),
            // The watcher's two scripts: PEXPIRE or DEL the key only while it holds ARGV[1].
            eval: vi.fn(async (script: string, { keys: [key], arguments: [value, ms] }: { keys: string[]; arguments: string[] }) => {
                if (this.values.get(key) !== value) {
                    return 0;
                }
                if (/PEXPIRE/.test(script)) {
                    this.ttls.set(key, Number(ms));
                } else if (/DEL/.test(script)) {
                    this.values.delete(key);
                } else {
                    throw new Error(`Unexpected script: ${script}`);
                }
                return 1;
            }),
            hSet: vi.fn(async (key: string, field: string, value: string) => {
                const hash = this.hashes.get(key) ?? new Map();
                hash.set(field, value);
                this.hashes.set(key, hash);
                return 1;
            }),
            hGetAll: vi.fn(async (key: string) => Object.fromEntries(this.hashes.get(key) ?? new Map())),
            hDel: vi.fn(async (key: string, field: string) => (this.hashes.get(key)?.delete(field) ? 1 : 0)),
        };
    }

    public publish(message: any): void {
        this.listeners.forEach((listener) => listener(typeof message === "string" ? message : JSON.stringify(message)));
    }
}

const plugin = (name: string, packageVersion = "1.0.0") => ({ name, packageVersion, enabled: true, settings: {} }) as any;

describe("PluginWatcher", () => {
    let redis: FakeRedis;
    let rows: any[];
    let restart: any;
    let watchers: PluginWatcher[];

    beforeEach(() => {
        redis = new FakeRedis();
        rows = [plugin("@rapidmx/activesync")];
        restart = vi.fn(async () => undefined);
        watchers = [];
    });

    afterEach(async () => {
        for (const w of watchers) {
            (w as any).restarting = false;
            (w as any).stopped = false;
            await w.stop();
        }
        setDraining(false);
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    function watcher(extra: Record<string, any> = {}) {
        const w = new PluginWatcher({
            instance: "pod-a",
            loadedHash: computePluginStateHash(rows),
            status: { loaded: [{ name: "@rapidmx/activesync", version: "1.0.0" }], errors: [], safeMode: false },
            readPlugins: async () => rows,
            restart,
            eventsUrl: "redis://events",
            cacheUrl: "redis://cache",
            createRedisClient: () => redis.client(),
            lockRetryMs: 1,
            lockReleaseDelayMs: 0,
            drainDelayMs: 0,
            restartJitterMs: 0,
            pollIntervalMs: 60_000,
            heartbeatIntervalMs: 60_000,
            logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
            ...extra,
        });
        watchers.push(w);
        return w;
    }

    it("reports its status and releases a restart lock it held from before it restarted", async () => {
        redis.values.set(PLUGIN_RESTART_LOCK_KEY, "pod-a");
        const w = watcher();
        await w.start();
        expect(redis.values.has(PLUGIN_RESTART_LOCK_KEY)).toBe(false);
        const status = JSON.parse(redis.hashes.get(PLUGIN_STATUS_KEY)!.get("pod-a")!);
        expect(status).toEqual(expect.objectContaining({ instance: "pod-a", hash: computePluginStateHash(rows), safeMode: false }));
        await w.stop();
    });

    it("keeps an inherited restart lock until it has been serving a while, renewing it meanwhile", async () => {
        vi.useFakeTimers();
        redis.values.set(PLUGIN_RESTART_LOCK_KEY, "pod-a");
        const client = redis.client();
        const w = watcher({ createRedisClient: () => client, lockReleaseDelayMs: 15_000, lockTtlMs: 3_000 });
        await w.start();
        await vi.advanceTimersByTimeAsync(14_000);
        expect(redis.values.get(PLUGIN_RESTART_LOCK_KEY)).toBe("pod-a");
        expect(client.eval).toHaveBeenCalledWith(expect.stringContaining("PEXPIRE"), { keys: [PLUGIN_RESTART_LOCK_KEY], arguments: ["pod-a", "3000"] });
        await vi.advanceTimersByTimeAsync(1_000);
        expect(redis.values.has(PLUGIN_RESTART_LOCK_KEY)).toBe(false);
    });

    it("leaves another copy's restart lock alone at startup", async () => {
        redis.values.set(PLUGIN_RESTART_LOCK_KEY, "pod-b");
        const w = watcher();
        await w.start();
        expect(redis.values.get(PLUGIN_RESTART_LOCK_KEY)).toBe("pod-b");
        await w.stop();
        expect(redis.values.get(PLUGIN_RESTART_LOCK_KEY)).toBe("pod-b");
    });

    it("logs Redis connection errors at most once a minute instead of letting them go unhandled", async () => {
        const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
        const w = watcher({ logger });
        await w.start();
        expect(redis.errorListeners).toHaveLength(2);
        redis.errorListeners.forEach((listener) => listener(new Error("ECONNRESET")));
        redis.errorListeners[0](new Error("ECONNRESET"));
        const logged = logger.warn.mock.calls.filter(([message]) => /Redis connection error/.test(message));
        expect(logged).toHaveLength(2);
        expect(logged[0][0]).toMatch(/ECONNRESET/);
    });

    it("ignores change messages matching what it loaded, and unrelated messages", async () => {
        const w = watcher();
        await w.start();
        redis.publish({ type: PLUGIN_CHANGED_EVENT, hash: computePluginStateHash(rows) });
        redis.publish({ type: "other" });
        redis.publish("not json");
        await w.check();
        expect(restart).not.toHaveBeenCalled();
        await w.stop();
    });

    it("restarts under the lock when a change message arrives, keeping the lock through its own stop", async () => {
        const w = watcher({ lockTtlMs: 600_000 });
        restart = vi.fn(async () => w.stop());
        (w as any).options.restart = restart;
        await w.start();
        rows = [plugin("@rapidmx/activesync", "1.1.0")];
        redis.publish({ type: PLUGIN_CHANGED_EVENT, hash: computePluginStateHash(rows) });
        await vi.waitFor(() => expect(restart).toHaveBeenCalledTimes(1));
        expect(redis.values.get(PLUGIN_RESTART_LOCK_KEY)).toBe("pod-a");
        expect(isDraining()).toBe(true);
    });

    it("reports itself not ready for the drain delay before restarting", async () => {
        vi.useFakeTimers();
        const w = watcher({ drainDelayMs: 15_000 });
        await w.start();
        rows = [];
        const checking = w.check();
        await vi.advanceTimersByTimeAsync(14_000);
        expect(isDraining()).toBe(true);
        expect(restart).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1_000);
        await checking;
        expect(restart).toHaveBeenCalledTimes(1);
    });

    it("waits for another copy's restart to finish before restarting", async () => {
        const w = watcher();
        await w.start();
        redis.values.set(PLUGIN_RESTART_LOCK_KEY, "pod-b");
        rows = [];
        const checking = w.check();
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(restart).not.toHaveBeenCalled();
        redis.values.delete(PLUGIN_RESTART_LOCK_KEY);
        await checking;
        expect(restart).toHaveBeenCalledTimes(1);
    });

    it("gives the lock back without restarting when the plugin set changed back while it waited", async () => {
        const original = rows;
        const w = watcher();
        await w.start();
        redis.values.set(PLUGIN_RESTART_LOCK_KEY, "pod-b");
        rows = [];
        const checking = w.check();
        await new Promise((resolve) => setTimeout(resolve, 10));
        rows = original;
        redis.values.delete(PLUGIN_RESTART_LOCK_KEY);
        await checking;
        expect(restart).not.toHaveBeenCalled();
        expect(redis.values.has(PLUGIN_RESTART_LOCK_KEY)).toBe(false);
        await w.stop();
    });

    it("shares one check between concurrent callers, and does nothing once stopped", async () => {
        const w = watcher();
        await w.start();
        rows = [];
        await Promise.all([w.check(), w.check()]);
        expect(restart).toHaveBeenCalledTimes(1);
        await w.check();
        expect(restart).toHaveBeenCalledTimes(1);
    });

    it("restarts after a random delay without Redis, relying on its periodic check", async () => {
        vi.useFakeTimers();
        vi.spyOn(Math, "random").mockReturnValue(0.5);
        const w = watcher({ eventsUrl: undefined, cacheUrl: undefined, pollIntervalMs: 1000, restartJitterMs: 30_000 });
        await w.start();
        rows = [];
        await vi.advanceTimersByTimeAsync(1000);
        await vi.advanceTimersByTimeAsync(14_000);
        expect(restart).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1_000);
        expect(restart).toHaveBeenCalledTimes(1);
    });

    it("in safe mode, restarts only once the plugin table changes from what it was when safe mode started", async () => {
        const w = watcher({ loadedHash: computePluginStateHash([]), status: { loaded: [], errors: [], safeMode: true } });
        await w.start();
        await w.check();
        redis.publish({ type: PLUGIN_CHANGED_EVENT, hash: computePluginStateHash(rows) });
        await w.check();
        expect(restart).not.toHaveBeenCalled();
        expect(JSON.parse(redis.hashes.get(PLUGIN_STATUS_KEY)!.get("pod-a")!).safeMode).toBe(true);

        rows = [{ ...rows[0], enabled: false }];
        await w.check();
        expect(restart).toHaveBeenCalledTimes(1);
    });

    it("takes the safe mode baseline at the first check when the plugin table can't be read at startup", async () => {
        let fail = true;
        const w = watcher({
            loadedHash: computePluginStateHash([]),
            status: { loaded: [], errors: [], safeMode: true },
            readPlugins: async () => (fail ? Promise.reject(new Error("db down")) : rows),
        });
        await w.start();
        fail = false;
        await w.check();
        expect(restart).not.toHaveBeenCalled();
        rows = [];
        await w.check();
        expect(restart).toHaveBeenCalledTimes(1);
    });

    it("restarts to retry after a failed plugin install, even though the plugin table is unchanged", async () => {
        vi.useFakeTimers();
        const w = watcher({ retryDelayMs: 120_000 });
        await w.start();
        await vi.advanceTimersByTimeAsync(119_000);
        expect(restart).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1_000);
        expect(restart).toHaveBeenCalledTimes(1);
    });

    it("logs a restart that fails", async () => {
        const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
        restart = vi.fn(async () => Promise.reject(new Error("stuck")));
        const w = watcher({ logger });
        await w.start();
        rows = [];
        await w.check();
        expect(logger.error).toHaveBeenCalledWith(expect.stringMatching(/failed: stuck/));
    });

    it("keeps running when Redis is unavailable or reading the plugin table fails", async () => {
        redis.failConnect = true;
        const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
        const w = watcher({ logger, readPlugins: async () => Promise.reject(new Error("db down")) });
        await w.start();
        expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/status reporting is unavailable/));
        expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/notifications are unavailable/));
        await w.check();
        expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/check failed: db down/));
        expect(restart).not.toHaveBeenCalled();
        await w.stop();
    });

    it("refreshes its status report on a timer and tolerates a failed report", async () => {
        vi.useFakeTimers();
        const client = redis.client();
        const w = watcher({ heartbeatIntervalMs: 1000, createRedisClient: () => client });
        await w.start();
        (client.hSet as any).mockRejectedValueOnce(new Error("busy"));
        await vi.advanceTimersByTimeAsync(1000);
        await vi.advanceTimersByTimeAsync(1000);
        expect(client.hSet).toHaveBeenCalledTimes(3);
        await w.stop();
    });

    it("prunes other copies' stale status reports, and removes its own when it stops", async () => {
        const status = new Map<string, string>([
            ["pod-old", JSON.stringify({ updatedAt: new Date(Date.now() - PLUGIN_STATUS_MAX_AGE_MS - 1000).toISOString() })],
            ["pod-junk", "not json"],
            ["pod-b", JSON.stringify({ updatedAt: new Date().toISOString() })],
        ]);
        redis.hashes.set(PLUGIN_STATUS_KEY, status);
        const w = watcher();
        await w.start();
        expect([...status.keys()].sort()).toEqual(["pod-a", "pod-b"]);
        await w.stop();
        expect([...status.keys()]).toEqual(["pod-b"]);
    });

    it("uses a cache connection and lock handed to it", async () => {
        const client = redis.client();
        redis.values.set(PLUGIN_RESTART_LOCK_KEY, "pod-a");
        const lock = new PluginRestartLock(client, "pod-a", 60_000);
        const createRedisClient = vi.fn(() => redis.client());
        const w = watcher({ cache: client, lock, eventsUrl: undefined, createRedisClient });
        await w.start();
        expect(createRedisClient).not.toHaveBeenCalled();
        expect(redis.values.has(PLUGIN_RESTART_LOCK_KEY)).toBe(false);
        expect(redis.hashes.get(PLUGIN_STATUS_KEY)!.has("pod-a")).toBe(true);
    });

    it("in safe mode, uses the failed plugin set's hash from the supervisor as its baseline", async () => {
        const failed = computePluginStateHash(rows);
        // An administrator already disabled the plugin by the time this copy started in safe mode.
        rows = [{ ...rows[0], enabled: false }];
        const w = watcher({ loadedHash: computePluginStateHash([]), status: { loaded: [], errors: [], safeMode: true }, safeModeBaseline: failed });
        await w.start();
        await w.check();
        expect(restart).toHaveBeenCalledTimes(1);
    });

    it("in safe mode, tries the plugins again after the retry delay even though nothing changed", async () => {
        vi.useFakeTimers();
        const w = watcher({ loadedHash: computePluginStateHash([]), status: { loaded: [], errors: [], safeMode: true }, safeModeRetryMs: 300_000 });
        await w.start();
        await vi.advanceTimersByTimeAsync(299_000);
        expect(restart).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1_000);
        expect(restart).toHaveBeenCalledTimes(1);
    });

    it("halts a rollout that failed to install on the copy that restarted into it, until a copy installs it cleanly", async () => {
        const next = [plugin("@rapidmx/activesync", "2.0.0")];
        const failing = watcher({ instance: "pod-a", loadedHash: computePluginStateHash(next), haltRollout: true, lockTtlMs: 5_000, heartbeatIntervalMs: 1_000 });
        await failing.start();
        expect(redis.values.get(PLUGIN_ROLLOUT_HALT_KEY)).toBe(computePluginStateHash(next));
        expect(redis.ttls.get(PLUGIN_ROLLOUT_HALT_KEY)).toBe(5_000);

        const other = watcher({ instance: "pod-b" });
        await other.start();
        rows = next;
        await other.check();
        expect(restart).not.toHaveBeenCalled();

        // A copy that installs it cleanly lifts the halt; one still on the old set leaves it alone.
        const healthy = watcher({ instance: "pod-c", loadedHash: computePluginStateHash(next) });
        await healthy.start();
        expect(redis.values.has(PLUGIN_ROLLOUT_HALT_KEY)).toBe(false);
        await other.check();
        expect(restart).toHaveBeenCalledTimes(1);
    });

    it("gives the lock back and doesn't restart when shut down part-way through a restart", async () => {
        vi.useFakeTimers();
        const w = watcher({ drainDelayMs: 15_000 });
        await w.start();
        rows = [];
        const checking = w.check();
        await vi.advanceTimersByTimeAsync(1_000);
        expect(redis.values.get(PLUGIN_RESTART_LOCK_KEY)).toBe("pod-a");
        await w.stop({ shutdown: true });
        expect(redis.values.has(PLUGIN_RESTART_LOCK_KEY)).toBe(false);
        expect(redis.hashes.get(PLUGIN_STATUS_KEY)!.has("pod-a")).toBe(false);
        await vi.advanceTimersByTimeAsync(15_000);
        await checking;
        expect(restart).not.toHaveBeenCalled();
        await w.stop({ shutdown: true });
    });
});

describe("PluginRestartLock", () => {
    it("takes a free lock, never takes or releases another copy's, and stops renewing once it's lost", async () => {
        vi.useFakeTimers();
        try {
            const redis = new FakeRedis();
            const client = redis.client();
            const a = new PluginRestartLock(client, "pod-a", 3_000);
            const b = new PluginRestartLock(redis.client(), "pod-b", 3_000);
            expect(await a.tryAcquire()).toBe(true);
            expect(await b.tryAcquire()).toBe(false);
            expect(await b.resume()).toBe(false);
            await b.release();
            expect(redis.values.get(PLUGIN_RESTART_LOCK_KEY)).toBe("pod-a");

            redis.values.set(PLUGIN_RESTART_LOCK_KEY, "pod-b");
            redis.ttls.delete(PLUGIN_RESTART_LOCK_KEY);
            await vi.advanceTimersByTimeAsync(3_000);
            // Checked and renewed in one script, so the other copy's lock was never extended.
            expect(redis.ttls.has(PLUGIN_RESTART_LOCK_KEY)).toBe(false);
            await a.release();
            expect(redis.values.get(PLUGIN_RESTART_LOCK_KEY)).toBe("pod-b");
            expect((a as any).renewTimer).toBeUndefined();
        } finally {
            vi.useRealTimers();
        }
    });

    it("stops renewing after its hold limit, unless the limit is cleared first", async () => {
        vi.useFakeTimers();
        try {
            const redis = new FakeRedis();
            const client = redis.client();
            const logger = { warn: vi.fn() };
            const lock = new PluginRestartLock(client, "pod-a", 3_000, logger);
            await lock.tryAcquire();
            lock.limitHold(10_000);
            await vi.advanceTimersByTimeAsync(10_000);
            expect((lock as any).renewTimer).toBeUndefined();
            expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/Still starting after 10s/));

            await lock.tryAcquire();
            lock.limitHold(10_000);
            lock.clearHoldLimit();
            await vi.advanceTimersByTimeAsync(20_000);
            expect((lock as any).renewTimer).toBeDefined();
            lock.stopRenewing();
        } finally {
            vi.useRealTimers();
        }
    });

    it("tolerates a failed renewal", async () => {
        vi.useFakeTimers();
        try {
            const redis = new FakeRedis();
            const client = redis.client();
            const logger = { debug: vi.fn() };
            const lock = new PluginRestartLock(client, "pod-a", 300, logger);
            await lock.tryAcquire();
            (client.eval as any).mockRejectedValueOnce(new Error("down"));
            await vi.advanceTimersByTimeAsync(100);
            expect(logger.debug).toHaveBeenCalledWith(expect.stringMatching(/renew.*down/));
            lock.stopRenewing();
        } finally {
            vi.useRealTimers();
        }
    });
});
