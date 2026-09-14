///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { createClient } from "redis";
import {
    computePluginStateHash,
    PLUGIN_CHANGED_EVENT,
    PLUGIN_EVENTS_CHANNEL,
    PLUGIN_STATUS_KEY,
    type Plugin,
    type PluginInstanceStatus,
} from "@rapidmx/restapi";

/** The Redis key a server copy holds while it restarts, so copies restart one at a time. */
export const PLUGIN_RESTART_LOCK_KEY = "plugins:restart-lock";

/** The subset of a node-redis client the watcher uses. */
export interface WatcherRedisClient {
    connect(): Promise<unknown>;
    disconnect?(): Promise<unknown>;
    quit?(): Promise<unknown>;
    subscribe(channel: string, listener: (message: string) => void): Promise<unknown>;
    set(key: string, value: string, options: { NX: true; PX: number }): Promise<string | null>;
    get(key: string): Promise<string | null>;
    del(key: string): Promise<number>;
    hSet(key: string, field: string, value: string): Promise<number>;
}

export interface PluginWatcherOptions {
    /** This server copy's identity in status reports and the restart lock. */
    instance: string;
    /** `computePluginStateHash()` of the plugin rows this copy started with. */
    loadedHash: string;
    status: Omit<PluginInstanceStatus, "instance" | "hash" | "updatedAt">;
    /** Reads the current plugin rows. */
    readPlugins: () => Promise<Plugin[]>;
    /** Stops this copy so it can start again with the new plugin set. */
    restart: () => Promise<void>;
    eventsUrl?: string;
    cacheUrl?: string;
    logger?: any;
    pollIntervalMs?: number;
    heartbeatIntervalMs?: number;
    lockRetryMs?: number;
    lockTtlMs?: number;
    createRedisClient?: (url: string) => WatcherRedisClient;
}

/**
 * Keeps a running server copy in step with the plugin table. It restarts the copy when the desired plugin set
 * no longer matches what the copy loaded - on a `plugins.changed` message, or on a periodic check in case a
 * message was missed - and reports what the copy loaded for the admin console.
 *
 * Restarts take the `plugins:restart-lock` Redis lock first, and the next process releases it once it has
 * started, so copies restart one at a time while the rest keep serving. Without a cache datastore there's no
 * lock: a single-copy deployment restarts straight away.
 */
export class PluginWatcher {
    private subscriber?: WatcherRedisClient;
    private cache?: WatcherRedisClient;
    private timers: NodeJS.Timeout[] = [];
    private checking?: Promise<void>;
    private restarting: boolean = false;
    private stopped: boolean = false;

    constructor(private readonly options: PluginWatcherOptions) {}

    private newClient(url: string): WatcherRedisClient {
        return this.options.createRedisClient ? this.options.createRedisClient(url) : (createClient({ url }));
    }

    public async start(): Promise<void> {
        const { cacheUrl, eventsUrl, logger } = this.options;
        if (cacheUrl) {
            try {
                this.cache = this.newClient(cacheUrl);
                await this.cache.connect();
                await this.releaseLock();
                await this.heartbeat();
            } catch (err: any) {
                logger?.warn(`Plugin status reporting is unavailable: ${err.message}`);
                this.cache = undefined;
            }
        }
        if (eventsUrl) {
            try {
                this.subscriber = this.newClient(eventsUrl);
                await this.subscriber.connect();
                await this.subscriber.subscribe(PLUGIN_EVENTS_CHANNEL, (message) => this.onMessage(message));
            } catch (err: any) {
                logger?.warn(`Plugin change notifications are unavailable; relying on periodic checks: ${err.message}`);
                this.subscriber = undefined;
            }
        }
        this.timers.push(setInterval(() => void this.check(), this.options.pollIntervalMs ?? 60_000));
        if (this.cache) {
            this.timers.push(setInterval(() => void this.heartbeat(), this.options.heartbeatIntervalMs ?? 30_000));
        }
    }

    public async stop(): Promise<void> {
        this.stopped = true;
        this.timers.forEach((timer) => clearInterval(timer));
        this.timers = [];
        for (const client of [this.subscriber, this.cache]) {
            await (client?.quit?.() ?? client?.disconnect?.())?.catch(() => undefined);
        }
        this.subscriber = undefined;
        this.cache = undefined;
    }

    private onMessage(message: string): void {
        try {
            const event: any = JSON.parse(message);
            if (event?.type === PLUGIN_CHANGED_EVENT && event.hash !== this.options.loadedHash) {
                void this.check();
            }
        } catch {
            // Not a message for us.
        }
    }

    /** Compares the plugin table with what this copy loaded, restarting when they differ. Concurrent calls share
     * one check. */
    public check(): Promise<void> {
        if (!this.checking) {
            this.checking = this.runCheck().finally(() => {
                this.checking = undefined;
            });
        }
        return this.checking;
    }

    private async desiredHash(): Promise<string> {
        return computePluginStateHash(await this.options.readPlugins());
    }

    private async runCheck(): Promise<void> {
        if (this.stopped || this.restarting) {
            return;
        }
        try {
            if ((await this.desiredHash()) === this.options.loadedHash) {
                return;
            }
            await this.acquireLock();
            // The plugin set may have changed back while this copy waited its turn.
            if (this.stopped || (await this.desiredHash()) === this.options.loadedHash) {
                await this.releaseLock();
                return;
            }
            this.restarting = true;
            this.options.logger?.info("The plugin set changed; restarting to apply it.");
            await this.stop();
            await this.options.restart();
        } catch (err: any) {
            this.options.logger?.warn(`Plugin change check failed: ${err.message}`);
        }
    }

    private async acquireLock(): Promise<void> {
        const { instance, lockRetryMs = 5_000, lockTtlMs = 5 * 60_000 } = this.options;
        while (this.cache && !this.stopped) {
            const acquired: string | null = await this.cache.set(PLUGIN_RESTART_LOCK_KEY, instance, { NX: true, PX: lockTtlMs });
            if (acquired || (await this.cache.get(PLUGIN_RESTART_LOCK_KEY)) === instance) {
                return;
            }
            await new Promise((resolve) => setTimeout(resolve, lockRetryMs + Math.floor(Math.random() * lockRetryMs)));
        }
    }

    /** Releases the restart lock if this copy holds it - called at startup, so the next copy can take its turn. */
    private async releaseLock(): Promise<void> {
        if (this.cache && (await this.cache.get(PLUGIN_RESTART_LOCK_KEY)) === this.options.instance) {
            await this.cache.del(PLUGIN_RESTART_LOCK_KEY);
        }
    }

    private async heartbeat(): Promise<void> {
        const { instance, loadedHash, status, logger } = this.options;
        try {
            const report: PluginInstanceStatus = { ...status, instance, hash: loadedHash, updatedAt: new Date().toISOString() };
            await this.cache?.hSet(PLUGIN_STATUS_KEY, instance, JSON.stringify(report));
        } catch (err: any) {
            logger?.debug?.(`Could not report plugin status: ${err.message}`);
        }
    }
}
