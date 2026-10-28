///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ObjectDecorators } from "@rapidrest/core";
import { attachRedisErrorHandler, ConnectionManager } from "@rapidrest/service-core";
const { Destroy, Inject, Logger } = ObjectDecorators;

/** The channel (on the `events` datastore) a saved change to the Integrations is announced on, with the row's new version (restapi spec 11.2). */
export const INTEGRATIONS_CHANGED_CHANNEL = "rapidmx:integrations:changed";

/** The datastore the notice goes through, like the plugin change message, the keyring's rotation notice and the DNS desired-state notice. */
const NOTICE_DATASTORE = "events";

/** Stops a listener from listening. */
export type IntegrationsListenerStop = () => Promise<void>;

/**
 * How a change to the Integrations reaches every server copy (spec 11.2): the route that saved it publishes the row's version, and each copy's
 * `IntegrationsSync` rebuilds the integrations layer when it hears one. Registered as `"IntegrationsChannel"`.
 */
export interface IntegrationsChannel {
    /** Announces that the row is now at `version`: to this process's listeners at once, and to the other copies. */
    publish(version: number): Promise<void>;
    /** Calls `listener` with the version of every change announced from now on. Rejects when the notice can't be heard (the caller's timer catches up). */
    subscribe(listener: (version: number) => void): Promise<IntegrationsListenerStop>;
}

/** The listeners of one process, shared by both channels. */
class Listeners {
    private readonly listeners: Set<(version: number) => void> = new Set();

    public add(listener: (version: number) => void): () => void {
        this.listeners.add(listener);
        return () => void this.listeners.delete(listener);
    }

    public get size(): number {
        return this.listeners.size;
    }

    public notify(version: number): void {
        for (const listener of [...this.listeners]) {
            listener(version);
        }
    }
}

/** A channel that reaches only this process: for a server without the two Redis datastores (the test harnesses), which is one copy. */
export class LocalIntegrationsChannel implements IntegrationsChannel {
    private readonly listeners: Listeners = new Listeners();

    public async publish(version: number): Promise<void> {
        this.listeners.notify(version);
    }

    public async subscribe(listener: (version: number) => void): Promise<IntegrationsListenerStop> {
        const remove: () => void = this.listeners.add(listener);
        return async () => remove();
    }
}

/** The subset of a node-redis client this uses. */
interface RedisClient {
    publish(channel: string, message: string): Promise<number>;
    duplicate(): RedisClient;
    connect(): Promise<unknown>;
    subscribe(channel: string, listener: (message: string) => void): Promise<unknown>;
    unsubscribe(channel: string): Promise<unknown>;
    quit(): Promise<unknown>;
    disconnect(): Promise<unknown>;
}

/**
 * The `IntegrationsChannel` the server registers: `rapidmx:integrations:changed` on the events Redis, heard through one subscriber connection of this process's
 * own (a node-redis client that subscribes can't run other commands), opened by the first listener and closed when the last stops or the channel is destroyed.
 * The connection logs its errors (an unhandled one would take the process down) and is closed again when it can't be opened or subscribed.
 *
 * A change is delivered to this process's own listeners directly as well, so the copy that saved it needn't wait on Redis to hear itself; a second delivery
 * through the notice is harmless (the listener compares the row's version). A copy that misses a notice catches up on its timer.
 */
export class RedisIntegrationsChannel implements IntegrationsChannel {
    @Inject(ConnectionManager)
    private connectionManager?: ConnectionManager;

    @Logger
    private logger: any;

    private readonly listeners: Listeners = new Listeners();
    private subscriber?: Promise<RedisClient>;
    /** The connection being opened or open, kept apart so it can be closed while it is still connecting. */
    private subscriberClient?: RedisClient;

    private client(): RedisClient {
        const client: any = this.connectionManager?.connections.get(NOTICE_DATASTORE);
        if (!client || typeof client.publish !== "function") {
            throw new Error(`The Redis datastore '${NOTICE_DATASTORE}' isn't configured, so the other server copies can't be told that the integrations changed.`);
        }
        return client;
    }

    public async publish(version: number): Promise<void> {
        this.listeners.notify(version);
        await this.client().publish(INTEGRATIONS_CHANGED_CHANNEL, String(version));
    }

    public async subscribe(listener: (version: number) => void): Promise<IntegrationsListenerStop> {
        await this.ensureSubscriber();
        const remove: () => void = this.listeners.add(listener);
        return async () => {
            remove();
            if (this.listeners.size === 0) {
                await this.closeSubscriber();
            }
        };
    }

    /** Opens the subscriber if it isn't; a failure is the caller's to handle, and leaves nothing open. */
    private async ensureSubscriber(): Promise<void> {
        if (!this.subscriber) {
            const opening: Promise<RedisClient> = this.openSubscriber();
            this.subscriber = opening;
            opening.catch(() => {
                // The next listener tries again, unless the channel was closed meanwhile and a newer attempt has taken the place.
                if (this.subscriber === opening) {
                    this.subscriber = undefined;
                }
            });
        }
        await this.subscriber;
    }

    private async openSubscriber(): Promise<RedisClient> {
        // The listener matters: a node-redis client whose socket fails emits `error`, and with no listener that takes the process down.
        const client: RedisClient = attachRedisErrorHandler(this.client().duplicate(), this.logger, "events (IntegrationsChannel)");
        this.subscriberClient = client;
        try {
            await client.connect();
            await client.subscribe(INTEGRATIONS_CHANGED_CHANNEL, (message: string) => {
                // Only a version counts: anything else on the channel is not ours to act on.
                if (/^\d{1,15}$/.test(message)) {
                    this.listeners.notify(Number(message));
                }
            });
        } catch (err) {
            // A connection that is left open keeps reconnecting, and the next attempt would add another to it.
            await this.close(client);
            throw err;
        }
        return client;
    }

    private async close(client: RedisClient): Promise<void> {
        if (this.subscriberClient === client) {
            this.subscriberClient = undefined;
        }
        await client.quit().catch(() => client.disconnect().catch(() => undefined));
    }

    private async closeSubscriber(): Promise<void> {
        this.subscriber = undefined;
        const client: RedisClient | undefined = this.subscriberClient;
        if (client) {
            await client.unsubscribe(INTEGRATIONS_CHANGED_CHANNEL).catch(() => undefined);
            await this.close(client);
        }
    }

    /** Closes the subscriber connection. Also run by the ObjectFactory when it destroys this instance. */
    @Destroy
    public async dispose(): Promise<void> {
        await this.closeSubscriber();
    }
}
