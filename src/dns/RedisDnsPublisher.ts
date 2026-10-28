///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import type { DnsDesiredStateChange, DnsPublisher } from "@rapidmx/restapi";
import { ObjectDecorators } from "@rapidrest/core";
import { attachRedisErrorHandler, ConnectionManager } from "@rapidrest/service-core";
const { Destroy, Inject, Logger } = ObjectDecorators;

/** The Redis key (on the `cache` datastore) holding the desired-state version: every change adds one, so every replica answers a long poll from the same count. */
export const DNS_DESIRED_STATE_VERSION_KEY = "rapidmx:dns:desired-state:version";

/** The channel (on the `events` datastore) a change is announced on, with the new version, to wake the long polls waiting on the other replicas. */
export const DNS_DESIRED_STATE_CHANGED_CHANNEL = "rapidmx:dns:desired-state:changed";

/** The datastore the counter lives on, like the plugin restart lock and the configuration keyring's heartbeats. */
const COUNTER_DATASTORE = "cache";
/** The datastore the notice goes through, like the plugin change message and the keyring's rotation notice. */
const NOTICE_DATASTORE = "events";

/** How often a waiting long poll reads the counter itself, whatever it has heard: a notice published while a replica's subscriber was reconnecting is gone. */
const DEFAULT_POLL_MS = 5_000;

/** The subset of a node-redis client this uses. */
interface RedisClient {
    get(key: string): Promise<string | null>;
    incr(key: string): Promise<number>;
    publish(channel: string, message: string): Promise<number>;
    duplicate(): RedisClient;
    connect(): Promise<unknown>;
    subscribe(channel: string, listener: (message: string) => void): Promise<unknown>;
    unsubscribe(channel: string): Promise<unknown>;
    quit(): Promise<unknown>;
    disconnect(): Promise<unknown>;
}

export interface RedisDnsPublisherOptions {
    /** How often a waiting long poll reads the counter itself (default 5 seconds). */
    pollMs?: number;
}

/**
 * The `DnsPublisher` the server registers (spec 7.3): the desired-state version is a counter in Redis, bumped by every change the routes announce and read by
 * every replica for the DNS controller's long poll (`GET /internal/dns/v1/desired-state?since=<version>`), so a change made through one replica ends a poll
 * waiting on another. A change also publishes the new version on the events datastore, which wakes the waiting polls of every replica at once through one
 * subscriber connection of this process's own; a poll of the counter every few seconds makes up for a notice that was missed. The counter is not persistent:
 * a Redis that restarts without its data starts again at 0, a version behind the controller's, which the route answers at once so the controller learns the new
 * count (7.3).
 *
 * The subscriber is never waited for: a long poll answers on its own deadline and abort whether or not the connection is up, and is woken once it is, so a
 * Redis that can't be reached costs a poll nothing but the notice. The connection logs its errors (an unhandled one would take the process down) and is closed
 * again when it can't be opened or subscribed.
 *
 * A Redis failure rejects the call: a change is already saved when it is announced, so the caller logs it and the controller's resync picks it up; a long poll
 * fails and the controller asks again with its backoff.
 */
export class RedisDnsPublisher implements DnsPublisher {
    @Inject(ConnectionManager)
    private connectionManager?: ConnectionManager;

    @Logger
    private logger: any;

    private readonly pollMs: number;
    private readonly waiters: Set<() => void> = new Set();
    private subscriber?: Promise<RedisClient | undefined>;
    /** The connection being opened or open, kept apart so it can be closed while it is still connecting. */
    private subscriberClient?: RedisClient;
    private subscribeWarned: boolean = false;

    constructor(options: RedisDnsPublisherOptions = {}) {
        this.pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    }

    /** The client of the configured datastore, or an error naming it: nothing here can work without it. */
    private client(datastore: string): RedisClient {
        const client: any = this.connectionManager?.connections.get(datastore);
        if (!client || typeof client.get !== "function") {
            throw new Error(`The Redis datastore '${datastore}' isn't configured, so the DNS controller can't be told about changes to the DNS desired state.`);
        }
        return client;
    }

    public async changed(_change: DnsDesiredStateChange): Promise<void> {
        const version: number = await this.client(COUNTER_DATASTORE).incr(DNS_DESIRED_STATE_VERSION_KEY);
        await this.client(NOTICE_DATASTORE).publish(DNS_DESIRED_STATE_CHANGED_CHANNEL, String(version));
    }

    public async version(): Promise<number> {
        const stored: string | null = await this.client(COUNTER_DATASTORE).get(DNS_DESIRED_STATE_VERSION_KEY);
        // A counter that isn't a count reads as 0, the same as none: the next change sets it right.
        return stored !== null && /^\d{1,15}$/.test(stored) ? Number(stored) : 0;
    }

    public async waitForChange(since: number, timeoutMs: number, signal?: AbortSignal): Promise<number> {
        const deadline: number = Date.now() + timeoutMs;
        let wake: (() => void) | undefined;
        let notified = false;
        const woken = (): void => {
            notified = true;
            wake?.();
        };
        // Listening before the counter is read, so a change landing between the route's read and this one is not missed.
        this.waiters.add(woken);
        try {
            // Not waited for: connecting retries for as long as Redis is down, and a poll must answer on its own deadline.
            void this.ensureSubscriber();
            for (;;) {
                notified = false;
                const version: number = await this.version();
                const remaining: number = deadline - Date.now();
                // Any other count is a change, a lower one too: the counter was reset.
                if (version !== since || remaining <= 0 || signal?.aborted) {
                    return version;
                }
                // A notice that arrived while the counter was being read may be for a change that read didn't see.
                if (notified) {
                    continue;
                }
                await new Promise<void>((resolve) => {
                    const done = (): void => {
                        clearTimeout(timer);
                        signal?.removeEventListener("abort", done);
                        wake = undefined;
                        resolve();
                    };
                    const timer: NodeJS.Timeout = setTimeout(done, Math.min(remaining, this.pollMs));
                    wake = done;
                    signal?.addEventListener("abort", done);
                });
            }
        } finally {
            this.waiters.delete(woken);
        }
    }

    /** Opens the subscriber on first use; a failure is said once and leaves the polls of the counter to do the waking. */
    private ensureSubscriber(): Promise<RedisClient | undefined> {
        if (!this.subscriber) {
            const opening: Promise<RedisClient | undefined> = this.openSubscriber().then(
                (client) => {
                    // A notice published while the connection was being opened is gone: have the waiting polls read the counter.
                    this.wakeWaiters();
                    return client;
                },
                (err: any) => {
                    if (!this.subscribeWarned) {
                        this.subscribeWarned = true;
                        this.logger?.warn(`The DNS desired-state notice can't be heard (${err?.message}); long polls see a change at their next poll of the counter instead.`);
                    }
                    // The next poll tries again, unless the publisher was destroyed meanwhile and a newer attempt has taken the place.
                    if (this.subscriber === opening) {
                        this.subscriber = undefined;
                    }
                    return undefined;
                },
            );
            this.subscriber = opening;
        }
        return this.subscriber;
    }

    private wakeWaiters(): void {
        for (const waiter of [...this.waiters]) {
            waiter();
        }
    }

    /** A connection of its own, since a node-redis client that subscribes can't run other commands. */
    private async openSubscriber(): Promise<RedisClient> {
        // The listener matters: a node-redis client whose socket fails emits `error`, and with no listener that takes the process down.
        const client: RedisClient = attachRedisErrorHandler(this.client(NOTICE_DATASTORE).duplicate(), this.logger, "events (DnsPublisher)");
        this.subscriberClient = client;
        try {
            await client.connect();
            await client.subscribe(DNS_DESIRED_STATE_CHANGED_CHANNEL, () => this.wakeWaiters());
        } catch (err) {
            // A connection that is left open keeps reconnecting, and the next poll would add another to it.
            await this.close(client);
            throw err;
        }
        return client;
    }

    /** Closes `client`, whatever state it is in, and forgets it as the subscriber. */
    private async close(client: RedisClient): Promise<void> {
        if (this.subscriberClient === client) {
            this.subscriberClient = undefined;
        }
        await client.quit().catch(() => client.disconnect().catch(() => undefined));
    }

    /** Closes the subscriber connection. Also run by the ObjectFactory when it destroys this instance. */
    @Destroy
    public async dispose(): Promise<void> {
        this.subscriber = undefined;
        const client: RedisClient | undefined = this.subscriberClient;
        if (client) {
            // Closed as it is, connected or not: a connection that is still being opened would otherwise hold the shutdown.
            await client.unsubscribe(DNS_DESIRED_STATE_CHANGED_CHANNEL).catch(() => undefined);
            await this.close(client);
        }
    }
}
