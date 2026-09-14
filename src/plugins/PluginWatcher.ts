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
    PLUGIN_STATUS_MAX_AGE_MS,
    type Plugin,
    type PluginInstanceStatus,
} from "@rapidmx/restapi";
import { setDraining } from "./readiness.js";

/** The Redis key a server copy holds while it restarts, so copies restart one at a time. */
export const PLUGIN_RESTART_LOCK_KEY = "plugins:restart-lock";

/** How long the restart lock lasts without being renewed - so a copy that crashes while holding it only blocks the
 * others this long. A copy renews it while it holds it. */
export const DEFAULT_LOCK_TTL_MS = 60_000;

/** How often a Redis client's connection errors are logged, at most. */
const ERROR_LOG_INTERVAL_MS = 60_000;

/** The subset of a node-redis client the watcher uses. */
export interface WatcherRedisClient {
    connect(): Promise<unknown>;
    disconnect?(): Promise<unknown>;
    quit?(): Promise<unknown>;
    on?(event: "error", listener: (err: Error) => void): unknown;
    subscribe(channel: string, listener: (message: string) => void): Promise<unknown>;
    set(key: string, value: string, options: { NX: true; PX: number }): Promise<string | null>;
    get(key: string): Promise<string | null>;
    del(key: string): Promise<number>;
    pExpire(key: string, ms: number): Promise<unknown>;
    hSet(key: string, field: string, value: string): Promise<number>;
    hGetAll(key: string): Promise<Record<string, string>>;
    hDel(key: string, field: string): Promise<number>;
}

/**
 * Creates a node-redis client that logs its connection errors (at most once a minute) instead of emitting them
 * unhandled - node-redis emits `error` on every failed reconnect, and an `error` event without a listener is thrown
 * as an uncaught exception, which would take the whole server down over a Redis blip.
 */
export function createWatcherRedisClient(url: string, logger?: any): WatcherRedisClient {
    const client: WatcherRedisClient = createClient({ url });
    return withErrorListener(client, url, logger);
}

/** Adds a rate-limited logging `error` listener to `client`. */
export function withErrorListener<C extends WatcherRedisClient>(client: C, url: string, logger?: any): C {
    let lastLogged: number = 0;
    client.on?.("error", (err: Error) => {
        const now: number = Date.now();
        if (now - lastLogged >= ERROR_LOG_INTERVAL_MS) {
            lastLogged = now;
            logger?.warn?.(`Plugin watcher Redis connection error (${url.replace(/\/\/[^@/]*@/, "//")}): ${err?.message ?? err}`);
        }
    });
    return client;
}

/**
 * The `plugins:restart-lock` lock, which copies take before restarting so they restart one at a time. It expires
 * after `ttlMs` unless renewed, and a copy renews it for as long as it holds it: from before it stops, and again in
 * the next process (`resume()`) from startup until it releases it once it is serving.
 */
export class PluginRestartLock {
    private renewTimer?: NodeJS.Timeout;

    constructor(
        private readonly client: WatcherRedisClient,
        private readonly instance: string,
        private readonly ttlMs: number = DEFAULT_LOCK_TTL_MS,
        private readonly logger?: any,
    ) {}

    public async isHeld(): Promise<boolean> {
        return (await this.client.get(PLUGIN_RESTART_LOCK_KEY)) === this.instance;
    }

    /** Takes the lock if it's free (or this copy already holds it), and keeps renewing it. */
    public async tryAcquire(): Promise<boolean> {
        const acquired: string | null = await this.client.set(PLUGIN_RESTART_LOCK_KEY, this.instance, { NX: true, PX: this.ttlMs });
        if (acquired || (await this.isHeld())) {
            this.keepAlive();
            return true;
        }
        return false;
    }

    /** Keeps renewing the lock if this copy holds it - taken by the process before a restart. */
    public async resume(): Promise<boolean> {
        if (await this.isHeld()) {
            this.keepAlive();
            return true;
        }
        return false;
    }

    public async release(): Promise<void> {
        this.stopRenewing();
        if (await this.isHeld()) {
            await this.client.del(PLUGIN_RESTART_LOCK_KEY);
        }
    }

    public stopRenewing(): void {
        clearInterval(this.renewTimer);
        this.renewTimer = undefined;
    }

    private keepAlive(): void {
        if (!this.renewTimer) {
            void this.renew();
            this.renewTimer = setInterval(() => void this.renew(), Math.max(1, Math.floor(this.ttlMs / 3)));
        }
    }

    private async renew(): Promise<void> {
        try {
            if (await this.isHeld()) {
                await this.client.pExpire(PLUGIN_RESTART_LOCK_KEY, this.ttlMs);
            } else {
                this.stopRenewing();
            }
        } catch (err: any) {
            this.logger?.debug?.(`Could not renew the plugin restart lock: ${err.message}`);
        }
    }
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
    /** An already connected cache client (with its restart lock), used instead of connecting to `cacheUrl`. */
    cache?: WatcherRedisClient;
    lock?: PluginRestartLock;
    logger?: any;
    pollIntervalMs?: number;
    heartbeatIntervalMs?: number;
    lockRetryMs?: number;
    lockTtlMs?: number;
    /** How long after starting this copy keeps the restart lock, so it is ready before the next copy stops. */
    lockReleaseDelayMs?: number;
    /** How long this copy reports itself not ready before stopping for a restart. */
    drainDelayMs?: number;
    /** Without a restart lock, the most a restart is randomly delayed by, so copies don't all restart at once. */
    restartJitterMs?: number;
    /** Set when plugins failed to install: restart after this long to try again. */
    retryDelayMs?: number;
    createRedisClient?: (url: string) => WatcherRedisClient;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Keeps a running server copy in step with the plugin table. It restarts the copy when the desired plugin set
 * no longer matches what the copy loaded - on a `plugins.changed` message, or on a periodic check in case a
 * message was missed - and reports what the copy loaded for the admin console.
 *
 * Restarts take the `plugins:restart-lock` Redis lock first, and the next process releases it a little while after
 * it has started, so copies restart one at a time while the rest keep serving. Without a cache datastore there's no
 * lock: each copy restarts after a random delay instead.
 *
 * In safe mode (no plugins loaded after repeated failed starts) the copy only restarts once the plugin table changes
 * from what it was when safe mode started - an administrator fixed or disabled something - rather than straight
 * back into the plugins that just failed.
 */
export class PluginWatcher {
    private subscriber?: WatcherRedisClient;
    private cache?: WatcherRedisClient;
    private lock?: PluginRestartLock;
    private timers: NodeJS.Timeout[] = [];
    private checking?: Promise<void>;
    private restarting: boolean = false;
    private stopped: boolean = false;
    private retryDue: boolean = false;
    private safeModeBaseline?: string;

    constructor(private readonly options: PluginWatcherOptions) {
        this.cache = options.cache;
        this.lock = options.lock;
    }

    private newClient(url: string): WatcherRedisClient {
        return this.options.createRedisClient
            ? withErrorListener(this.options.createRedisClient(url), url, this.options.logger)
            : createWatcherRedisClient(url, this.options.logger);
    }

    public async start(): Promise<void> {
        const { cacheUrl, eventsUrl, logger, instance, lockTtlMs, status } = this.options;
        if (!this.cache && cacheUrl) {
            try {
                this.cache = this.newClient(cacheUrl);
                await this.cache.connect();
            } catch (err: any) {
                logger?.warn(`Plugin status reporting is unavailable: ${err.message}`);
                this.cache = undefined;
            }
        }
        if (this.cache) {
            this.lock ??= new PluginRestartLock(this.cache, instance, lockTtlMs ?? DEFAULT_LOCK_TTL_MS, logger);
            try {
                if (await this.lock.resume()) {
                    await this.scheduleLockRelease();
                }
                await this.heartbeat();
            } catch (err: any) {
                logger?.warn(`Plugin status reporting is unavailable: ${err.message}`);
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
        if (status.safeMode) {
            try {
                this.safeModeBaseline = await this.desiredHash();
            } catch {
                // Taken at the first check that can read the plugin table instead.
            }
        }
        this.timers.push(setInterval(() => void this.check(), this.options.pollIntervalMs ?? 60_000));
        if (this.cache) {
            this.timers.push(setInterval(() => void this.heartbeat(), this.options.heartbeatIntervalMs ?? 30_000));
        }
        if (this.options.retryDelayMs !== undefined && !status.safeMode) {
            logger?.warn(`Plugins failed to install; trying again in ${Math.round(this.options.retryDelayMs / 1000)}s.`);
            this.timers.push(
                setTimeout(() => {
                    this.retryDue = true;
                    void this.check();
                }, this.options.retryDelayMs),
            );
        }
    }

    /** Stops watching. Unless this copy is restarting, it also gives back the restart lock and its status report. */
    public async stop(): Promise<void> {
        const wasStopped: boolean = this.stopped;
        this.stopped = true;
        this.timers.forEach((timer) => clearTimeout(timer));
        this.timers = [];
        await (this.subscriber?.quit?.() ?? this.subscriber?.disconnect?.())?.catch(() => undefined);
        this.subscriber = undefined;
        if (this.restarting) {
            // The cache connection stays open so the lock keeps being renewed until this process exits.
            return;
        }
        if (this.cache && !wasStopped) {
            await this.lock?.release().catch(() => undefined);
            await this.cache.hDel(PLUGIN_STATUS_KEY, this.options.instance).catch(() => undefined);
        }
        this.lock?.stopRenewing();
        await (this.cache?.quit?.() ?? this.cache?.disconnect?.())?.catch(() => undefined);
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

    private async needsRestart(): Promise<boolean> {
        const desired: string = await this.desiredHash();
        if (this.options.status.safeMode) {
            if (this.safeModeBaseline === undefined) {
                this.safeModeBaseline = desired;
            }
            return desired !== this.safeModeBaseline;
        }
        return this.retryDue || desired !== this.options.loadedHash;
    }

    private async runCheck(): Promise<void> {
        if (this.stopped || this.restarting) {
            return;
        }
        const { logger, drainDelayMs = 15_000 } = this.options;
        try {
            if (!(await this.needsRestart())) {
                return;
            }
            if (!(await this.acquireLock())) {
                return;
            }
            // The plugin set may have changed back while this copy waited its turn.
            if (this.stopped || !(await this.needsRestart())) {
                await this.lock?.release();
                return;
            }
        } catch (err: any) {
            logger?.warn(`Plugin change check failed: ${err.message}`);
            return;
        }

        this.restarting = true;
        logger?.info("The plugin set changed; restarting to apply it.");
        setDraining(true);
        try {
            await this.stop();
            if (drainDelayMs > 0) {
                await sleep(drainDelayMs);
            }
        } catch (err: any) {
            logger?.warn(`Could not stop watching plugins cleanly: ${err.message}`);
        }
        await this.options.restart().catch((err: any) => logger?.error?.(`Restarting to apply plugin changes failed: ${err.message}`));
    }

    /** Waits for this copy's turn to restart. Resolves `false` if the watcher stopped meanwhile. */
    private async acquireLock(): Promise<boolean> {
        const { lockRetryMs = 5_000, restartJitterMs = 30_000 } = this.options;
        if (!this.lock) {
            if (restartJitterMs > 0) {
                await sleep(Math.floor(Math.random() * restartJitterMs));
            }
            return !this.stopped;
        }
        while (!this.stopped) {
            if (await this.lock.tryAcquire()) {
                return true;
            }
            await sleep(lockRetryMs + Math.floor(Math.random() * lockRetryMs));
        }
        return false;
    }

    /** Releases the restart lock this copy inherited once it has been serving for a little while, so the load balancer
     * sees it ready before the next copy stops. */
    private async scheduleLockRelease(): Promise<void> {
        const { lockReleaseDelayMs = 15_000, logger } = this.options;
        const release = () => this.lock?.release().catch((err: any) => logger?.debug?.(`Could not release the plugin restart lock: ${err.message}`));
        if (lockReleaseDelayMs <= 0) {
            await release();
        } else {
            this.timers.push(setTimeout(() => void release(), lockReleaseDelayMs));
        }
    }

    private async heartbeat(): Promise<void> {
        const { instance, loadedHash, status, logger } = this.options;
        try {
            const report: PluginInstanceStatus = { ...status, instance, hash: loadedHash, updatedAt: new Date().toISOString() };
            await this.cache?.hSet(PLUGIN_STATUS_KEY, instance, JSON.stringify(report));
            // Copies that went away without removing their report (a crash, a scaled-down pod) are pruned here.
            const cutoff: number = Date.now() - PLUGIN_STATUS_MAX_AGE_MS;
            const entries: Record<string, string> = (await this.cache?.hGetAll(PLUGIN_STATUS_KEY)) ?? {};
            for (const [field, value] of Object.entries(entries)) {
                let updatedAt: number = NaN;
                try {
                    updatedAt = Date.parse(JSON.parse(value)?.updatedAt);
                } catch {
                    // Unreadable: pruned.
                }
                if (field !== instance && !(updatedAt >= cutoff)) {
                    await this.cache?.hDel(PLUGIN_STATUS_KEY, field);
                }
            }
        } catch (err: any) {
            logger?.debug?.(`Could not report plugin status: ${err.message}`);
        }
    }
}
