///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
// What a purge reads to tell whether some server copy might still run the plugin.
import { PLUGIN_STATUS_KEY } from "@rapidmx/restapi";
import {
    blockingInstances,
    clearStarting,
    markStarting,
    PLUGIN_STARTING_KEY,
    RedisPurgeCoordination,
} from "../../src/plugins/PluginPurgeCoordination.js";
import { PLUGIN_RESTART_LOCK_KEY } from "../../src/plugins/PluginWatcher.js";

const NOW = Date.parse("2026-09-21T12:00:00Z");
const PLUGIN = "@rapidmx/notes-plugin";
const status = (instance: string, extra: Record<string, unknown> = {}) => ({
    instance,
    hash: "desired",
    loaded: [],
    errors: [],
    safeMode: false,
    updatedAt: new Date(NOW - 10_000).toISOString(),
    ...extra,
});

describe("blockingInstances", () => {
    it("blocks on a copy that lists the plugin, reports an error for it, or hasn't applied the current plugin set", () => {
        const result = blockingInstances(
            [
                status("runs", { loaded: [{ name: PLUGIN, version: "1" }] }),
                status("errors", { errors: [{ name: PLUGIN, message: "x" }] }),
                status("behind", { hash: "older" }),
                status("clear"),
                status("other-plugin", { loaded: [{ name: "@rapidmx/mapi-plugin", version: "1" }], errors: [{ name: "*", message: "x" }] }),
            ],
            PLUGIN,
            "desired",
            NOW,
        );
        expect(result).toEqual({ blocking: ["runs", "errors", "behind"], total: 5 });
    });

    it("doesn't wait for a copy in safe mode (it runs no plugins) or one whose report went stale (it went away)", () => {
        const result = blockingInstances(
            [
                status("safe", { safeMode: true, hash: "whatever" }),
                status("gone", { loaded: [{ name: PLUGIN, version: "1" }], updatedAt: new Date(NOW - 5 * 60_000).toISOString() }),
                status("unparseable-time", { hash: "older", updatedAt: "not a date" }),
                status("clear"),
            ],
            PLUGIN,
            "desired",
            NOW,
        );
        expect(result).toEqual({ blocking: [], total: 2 });
    });

    it("tolerates a report missing its lists", () => {
        expect(blockingInstances([{ instance: "a", hash: "desired", safeMode: false, updatedAt: new Date(NOW).toISOString() } as any], PLUGIN, "desired", NOW)).toEqual({ blocking: [], total: 1 });
    });
});

/** A Redis client with just the calls the coordination makes. */
function fakeClient(data: { status?: Record<string, string>; starting?: Record<string, string>; lock?: string | null } = {}) {
    const calls: string[] = [];
    const client: any = {
        connect: vi.fn(async () => calls.push("connect")),
        quit: vi.fn(async () => calls.push("quit")),
        hGetAll: vi.fn(async (key: string) => (key === PLUGIN_STATUS_KEY ? data.status ?? {} : key === PLUGIN_STARTING_KEY ? data.starting ?? {} : {})),
        get: vi.fn(async (key: string) => (key === PLUGIN_RESTART_LOCK_KEY ? data.lock ?? null : null)),
        hSet: vi.fn(async () => 1),
        hDel: vi.fn(async () => 1),
    };
    return { client, calls };
}

describe("RedisPurgeCoordination", () => {
    it("is unconfigured without a cache URL", () => {
        expect(new RedisPurgeCoordination(undefined).configured).toBe(false);
        expect(new RedisPurgeCoordination("redis://cache").configured).toBe(true);
    });

    it("reads every copy's report (skipping unreadable ones), who is starting, and whether the restart lock is held", async () => {
        const { client, calls } = fakeClient({
            status: { a: JSON.stringify(status("a")), b: "{not json", c: JSON.stringify(status("c")) },
            starting: { "pod-z": String(NOW - 1000) },
            lock: "pod-y",
        });
        const coordination = new RedisPurgeCoordination("redis://cache", undefined, () => client);
        expect(await coordination.snapshot()).toEqual({
            instances: [status("a"), status("c")],
            restartLockHeld: true,
            starting: [{ instance: "pod-z", at: NOW - 1000 }],
        });
        expect(calls).toEqual(["connect", "quit"]);
    });

    it("reads nothing held and nobody starting", async () => {
        const { client } = fakeClient();
        expect(await new RedisPurgeCoordination("redis://cache", undefined, () => client).snapshot()).toEqual({ instances: [], restartLockHeld: false, starting: [] });
    });

    it("closes the connection when reading fails, and passes the failure on, and disconnects when there is no quit", async () => {
        const { client } = fakeClient();
        client.hGetAll.mockRejectedValueOnce(new Error("WRONGTYPE"));
        await expect(new RedisPurgeCoordination("redis://cache", undefined, () => client).snapshot()).rejects.toThrow("WRONGTYPE");
        expect(client.quit).toHaveBeenCalled();

        const noQuit: any = { ...fakeClient().client, quit: undefined, disconnect: vi.fn(async () => undefined) };
        await new RedisPurgeCoordination("redis://cache", undefined, () => noQuit).snapshot();
        expect(noQuit.disconnect).toHaveBeenCalled();
    });

    it("marks and clears a starting copy", async () => {
        const { client } = fakeClient();
        await markStarting(client, "pod-a", NOW);
        expect(client.hSet).toHaveBeenCalledWith(PLUGIN_STARTING_KEY, "pod-a", String(NOW));
        await clearStarting(client, "pod-a");
        expect(client.hDel).toHaveBeenCalledWith(PLUGIN_STARTING_KEY, "pod-a");
        await markStarting(client, "pod-b");
        expect(Number(client.hSet.mock.calls[1][2])).toBeGreaterThan(NOW);
    });
});
