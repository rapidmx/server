///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { computePluginStateHash, PLUGIN_CHANGED_EVENT, PLUGIN_EVENTS_CHANNEL, PLUGIN_STATUS_KEY } from "@rapidmx/restapi";
import { PLUGIN_RESTART_LOCK_KEY, PluginWatcher, type WatcherRedisClient } from "../../src/plugins/PluginWatcher.js";

/** A shared in-memory Redis for the watcher's cache and subscriber clients. */
class FakeRedis {
    public values: Map<string, string> = new Map();
    public hashes: Map<string, Map<string, string>> = new Map();
    public listeners: ((message: string) => void)[] = [];
    public failConnect: boolean = false;

    public client(): WatcherRedisClient & { quit: any } {
        return {
            connect: vi.fn(async () => {
                if (this.failConnect) {
                    throw new Error("connection refused");
                }
            }),
            quit: vi.fn(async () => undefined),
            subscribe: vi.fn(async (channel: string, listener: (message: string) => void) => {
                expect(channel).toBe(PLUGIN_EVENTS_CHANNEL);
                this.listeners.push(listener);
            }),
            set: vi.fn(async (key: string, value: string) => {
                if (this.values.has(key)) {
                    return null;
                }
                this.values.set(key, value);
                return "OK";
            }),
            get: vi.fn(async (key: string) => this.values.get(key) ?? null),
            del: vi.fn(async (key: string) => (this.values.delete(key) ? 1 : 0)),
            hSet: vi.fn(async (key: string, field: string, value: string) => {
                const hash = this.hashes.get(key) ?? new Map();
                hash.set(field, value);
                this.hashes.set(key, hash);
                return 1;
            }),
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

    beforeEach(() => {
        redis = new FakeRedis();
        rows = [plugin("@rapidmx/activesync")];
        restart = vi.fn(async () => undefined);
    });

    function watcher(extra: Record<string, any> = {}) {
        return new PluginWatcher({
            instance: "pod-a",
            loadedHash: computePluginStateHash(rows),
            status: { loaded: [{ name: "@rapidmx/activesync", version: "1.0.0" }], errors: [], safeMode: false },
            readPlugins: async () => rows,
            restart,
            eventsUrl: "redis://events",
            cacheUrl: "redis://cache",
            createRedisClient: () => redis.client(),
            lockRetryMs: 1,
            pollIntervalMs: 60_000,
            heartbeatIntervalMs: 60_000,
            logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
            ...extra,
        });
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

    it("leaves another copy's restart lock alone at startup", async () => {
        redis.values.set(PLUGIN_RESTART_LOCK_KEY, "pod-b");
        const w = watcher();
        await w.start();
        expect(redis.values.get(PLUGIN_RESTART_LOCK_KEY)).toBe("pod-b");
        await w.stop();
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

    it("restarts under the lock when a change message arrives and the plugin set really differs", async () => {
        const loaded = computePluginStateHash(rows);
        const w = watcher({ loadedHash: loaded });
        await w.start();
        rows = [plugin("@rapidmx/activesync", "1.1.0")];
        redis.publish({ type: PLUGIN_CHANGED_EVENT, hash: computePluginStateHash(rows) });
        await vi.waitFor(() => expect(restart).toHaveBeenCalledTimes(1));
        expect(redis.values.get(PLUGIN_RESTART_LOCK_KEY)).toBe("pod-a");
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

    it("restarts immediately without Redis, relying on its periodic check", async () => {
        vi.useFakeTimers();
        try {
            const w = watcher({ eventsUrl: undefined, cacheUrl: undefined, pollIntervalMs: 1000 });
            await w.start();
            rows = [];
            await vi.advanceTimersByTimeAsync(1000);
            expect(restart).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
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
        try {
            const client = redis.client();
            const w = watcher({ heartbeatIntervalMs: 1000, createRedisClient: () => client });
            await w.start();
            (client.hSet as any).mockRejectedValueOnce(new Error("busy"));
            await vi.advanceTimersByTimeAsync(1000);
            await vi.advanceTimersByTimeAsync(1000);
            expect(client.hSet).toHaveBeenCalledTimes(3);
            await w.stop();
        } finally {
            vi.useRealTimers();
        }
    });
});
