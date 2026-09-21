///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { PLUGIN_STATUS_KEY, PLUGIN_STATUS_MAX_AGE_MS, type PluginInstanceStatus } from "@rapidmx/restapi";
import { createWatcherRedisClient, PLUGIN_RESTART_LOCK_KEY, type WatcherRedisClient } from "./PluginWatcher.js";

/** A Redis hash, `instance -> ISO time`, of server copies that are starting up: between reading the plugin table and
 * reporting what they loaded, a copy is invisible in `plugins:status`, yet may be about to load a plugin. */
export const PLUGIN_STARTING_KEY = "plugins:starting";

/** How long a `plugins:starting` entry counts, when the copy that wrote it never cleared it (it crashed). */
export const DEFAULT_STARTING_MAX_AGE_MS = 15 * 60_000;

/** Everything a purge looks at to tell whether any server copy might still run a plugin. */
export interface PurgeCoordinationSnapshot {
    /** Every copy's last report, including ones too old to count (see `blockingInstances()`). */
    instances: PluginInstanceStatus[];
    /** Whether some copy holds the restart lock, i.e. a rollout is under way. */
    restartLockHeld: boolean;
    /** Copies that started up and haven't reported yet: `instance` and when (epoch ms). */
    starting: { instance: string; at: number }[];
}

/**
 * The server copies that could still be running `pluginName`, from their status reports (`plugins:status`): a copy blocks
 * a purge when it lists the plugin as loaded, reports an error for it (it may have half loaded it), or hasn't yet
 * applied the plugin set with the plugin removed (its `hash` differs from `desiredHash`; a copy in safe mode runs no
 * plugins and doesn't block). Reports older than `PLUGIN_STATUS_MAX_AGE_MS` are copies that went away.
 */
export function blockingInstances(
    instances: PluginInstanceStatus[],
    pluginName: string,
    desiredHash: string,
    now: number,
): { blocking: string[]; total: number } {
    const fresh: PluginInstanceStatus[] = instances.filter((instance) => Date.parse(instance.updatedAt) >= now - PLUGIN_STATUS_MAX_AGE_MS);
    const blocking: string[] = fresh
        .filter(
            (instance) =>
                instance.loaded?.some((entry) => entry.name === pluginName) ||
                instance.errors?.some((entry) => entry.name === pluginName) ||
                (!instance.safeMode && instance.hash !== desiredHash),
        )
        .map((instance) => instance.instance);
    return { blocking, total: fresh.length };
}

/** Reads what `blockingInstances()` and the purge's other checks need from the cache datastore (Redis). */
export class RedisPurgeCoordination {
    /**
     * @param url The cache datastore's URL; without one there's a single server copy and nothing to coordinate with.
     * @param createClient Test seam.
     */
    constructor(
        private readonly url: string | undefined,
        private readonly logger?: any,
        private readonly createClient: (url: string) => WatcherRedisClient = (url) => createWatcherRedisClient(url, logger),
    ) {}

    /** Whether there's a cache to read: without one no other copy can be known about. */
    public get configured(): boolean {
        return !!this.url;
    }

    /** @throws when the cache can't be read - the caller must then treat every copy as possibly running the plugin. */
    public async snapshot(): Promise<PurgeCoordinationSnapshot> {
        const client: WatcherRedisClient = this.createClient(this.url!);
        await client.connect();
        try {
            const reports: Record<string, string> = await client.hGetAll(PLUGIN_STATUS_KEY);
            const instances: PluginInstanceStatus[] = [];
            for (const raw of Object.values(reports)) {
                try {
                    instances.push(JSON.parse(raw));
                } catch {
                    // Unreadable: pruned by the copies' own heartbeats; it can't say what it runs.
                }
            }
            const starting: { instance: string; at: number }[] = Object.entries(await client.hGetAll(PLUGIN_STARTING_KEY)).map(([instance, at]) => ({
                instance,
                at: Number(at),
            }));
            const lock: string | null = await client.get(PLUGIN_RESTART_LOCK_KEY);
            return { instances, restartLockHeld: !!lock, starting };
        } finally {
            await (client.quit?.() ?? client.disconnect?.())?.catch(() => undefined);
        }
    }
}

/** Notes that `instance` is starting: it may load plugins it read from the plugin table before they were removed. */
export async function markStarting(client: WatcherRedisClient, instance: string, now: number = Date.now()): Promise<void> {
    await client.hSet(PLUGIN_STARTING_KEY, instance, String(now));
}

/** Clears `markStarting()`, once the copy reports what it loaded (or gives up). */
export async function clearStarting(client: WatcherRedisClient, instance: string): Promise<void> {
    await client.hDel(PLUGIN_STARTING_KEY, instance);
}
