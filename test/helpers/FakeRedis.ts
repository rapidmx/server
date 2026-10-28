///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2020-2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
// A minimal in-memory fake of the `redis` (node-redis v4+) client, covering exactly the subset of the API
// this codebase actually uses: get/set/setEx/ttl/del/unlink/scanIterator/multi(...).execAsPipeline[Typed](),
// publish/subscribe/unsubscribe, and connect/disconnect/duplicate/isOpen. Used in place of the no-longer
// relevant `ioredis-mock` package now that the codebase talks to `redis` instead of `ioredis`.

import { EventEmitter } from "node:events";

type PubSubListener = (message: string, channel: string) => void;

interface Entry {
    value: string;
    expiresAt?: number;
}

function globToRegExp(pattern: string): RegExp {
    const escaped = pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".");
    return new RegExp(`^${escaped}$`);
}

/** Shared in-memory backing store + pub/sub bus for every `FakeRedisClient` created from the same server. */
export class FakeRedisServer {
    private store: Map<string, Entry> = new Map();
    private subscribers: Map<string, Set<PubSubListener>> = new Map();

    private isExpired(entry: Entry): boolean {
        return entry.expiresAt !== undefined && entry.expiresAt <= Date.now();
    }

    public get(key: string): string | null {
        const entry: Entry | undefined = this.store.get(key);
        if (!entry || this.isExpired(entry)) {
            this.store.delete(key);
            return null;
        }
        return entry.value;
    }

    public set(key: string, value: string): void {
        this.store.set(key, { value });
    }

    public setEx(key: string, seconds: number, value: string): void {
        this.store.set(key, { value, expiresAt: Date.now() + seconds * 1000 });
    }

    /** Adds one to the integer at `key` (0 when there is none), keeping its expiry, and answers the new value. */
    public incr(key: string): number {
        const entry: Entry | undefined = this.store.get(key);
        const live: Entry | undefined = entry && !this.isExpired(entry) ? entry : undefined;
        const next: number = (live ? Number(live.value) : 0) + 1;
        this.store.set(key, { value: String(next), expiresAt: live?.expiresAt });
        return next;
    }

    public ttl(key: string): number {
        const entry: Entry | undefined = this.store.get(key);
        if (!entry || this.isExpired(entry)) {
            return -2;
        }
        if (entry.expiresAt === undefined) {
            return -1;
        }
        return Math.max(0, Math.round((entry.expiresAt - Date.now()) / 1000));
    }

    public del(keys: string | string[]): number {
        const list: string[] = Array.isArray(keys) ? keys : [keys];
        let count = 0;
        for (const key of list) {
            if (this.store.delete(key)) {
                count++;
            }
        }
        return count;
    }

    public flushAll(): void {
        this.store.clear();
    }

    public keys(pattern: string): string[] {
        const re: RegExp = globToRegExp(pattern);
        return [...this.store.keys()].filter((key) => {
            const entry: Entry | undefined = this.store.get(key);
            return !!entry && !this.isExpired(entry) && re.test(key);
        });
    }

    public publish(channel: string, message: string): number {
        const subs: Set<PubSubListener> | undefined = this.subscribers.get(channel);
        if (!subs) {
            return 0;
        }
        // Real Redis pub/sub delivery always crosses a socket, so it's never observable synchronously
        // within the publishing call — deferred here (rather than calling listeners inline) so code that
        // publishes and then immediately does something else (e.g. sends a confirmation message) isn't
        // racing a same-tick delivery that could never happen against a real server.
        const listeners: PubSubListener[] = [...subs];
        queueMicrotask(() => {
            for (const listener of listeners) {
                listener(message, channel);
            }
        });
        return subs.size;
    }

    public subscribe(channel: string, listener: PubSubListener): void {
        if (!this.subscribers.has(channel)) {
            this.subscribers.set(channel, new Set());
        }
        this.subscribers.get(channel)!.add(listener);
    }

    public unsubscribe(channel: string, listener?: PubSubListener): void {
        const subs: Set<PubSubListener> | undefined = this.subscribers.get(channel);
        if (!subs) {
            return;
        }
        if (listener) {
            subs.delete(listener);
        } else {
            subs.clear();
        }
    }
}

class FakeMulti {
    private ops: Array<() => any> = [];

    constructor(private readonly client: FakeRedisClient) {}

    public get(key: string): this {
        this.ops.push(() => this.client.get(key));
        return this;
    }

    public ttl(key: string): this {
        this.ops.push(() => this.client.ttl(key));
        return this;
    }

    public setEx(key: string, seconds: number, value: string): this {
        this.ops.push(() => this.client.setEx(key, seconds, value));
        return this;
    }

    public async execAsPipeline(): Promise<any[]> {
        return Promise.all(this.ops.map((op) => op()));
    }

    public async execAsPipelineTyped(): Promise<any[]> {
        return this.execAsPipeline();
    }
}

/** A single fake connection to a `FakeRedisServer`. Multiple clients on the same server behave like multiple
 * real connections to the same Redis instance: they share data and pub/sub, independently of one another. */
export class FakeRedisClient extends EventEmitter {
    public isOpen: boolean = false;
    public isReady: boolean = false;
    private readonly listenersByChannel: Map<string, PubSubListener> = new Map();

    constructor(private readonly server: FakeRedisServer) {
        super();
    }

    public async connect(): Promise<this> {
        this.isOpen = true;
        this.isReady = true;
        return this;
    }

    public async disconnect(): Promise<void> {
        for (const [channel, listener] of this.listenersByChannel) {
            this.server.unsubscribe(channel, listener);
        }
        this.listenersByChannel.clear();
        this.isOpen = false;
        this.isReady = false;
    }

    public quit(): Promise<void> {
        return this.disconnect();
    }

    public duplicate(): FakeRedisClient {
        const Ctor: new (server: FakeRedisServer) => FakeRedisClient = this.constructor as any;
        return new Ctor(this.server);
    }

    public async get(key: string): Promise<string | null> {
        return this.server.get(key);
    }

    public async set(key: string, value: string, options?: { EX?: number }): Promise<string> {
        if (options?.EX !== undefined) {
            this.server.setEx(key, options.EX, value);
        } else {
            this.server.set(key, value);
        }
        return "OK";
    }

    public async incr(key: string): Promise<number> {
        return this.server.incr(key);
    }

    public async setEx(key: string, seconds: number, value: string): Promise<string> {
        this.server.setEx(key, seconds, value);
        return "OK";
    }

    public async ttl(key: string): Promise<number> {
        return this.server.ttl(key);
    }

    public async del(keys: string | string[]): Promise<number> {
        return this.server.del(keys);
    }

    public async unlink(keys: string | string[]): Promise<number> {
        return this.server.del(keys);
    }

    public async flushAll(): Promise<string> {
        this.server.flushAll();
        return "OK";
    }

    public async *scanIterator(opts?: { MATCH?: string }): AsyncGenerator<string[]> {
        const keys: string[] = this.server.keys(opts?.MATCH ?? "*");
        if (keys.length > 0) {
            yield keys;
        }
    }

    public multi(): FakeMulti {
        return new FakeMulti(this);
    }

    public async publish(channel: string, message: string): Promise<number> {
        return this.server.publish(channel, message);
    }

    public async subscribe(channels: string | string[], listener: PubSubListener): Promise<void> {
        for (const channel of Array.isArray(channels) ? channels : [channels]) {
            this.server.subscribe(channel, listener);
            this.listenersByChannel.set(channel, listener);
        }
    }

    public async unsubscribe(channels?: string | string[]): Promise<void> {
        const list: string[] = channels
            ? Array.isArray(channels)
                ? channels
                : [channels]
            : [...this.listenersByChannel.keys()];
        for (const channel of list) {
            const listener: PubSubListener | undefined = this.listenersByChannel.get(channel);
            this.server.unsubscribe(channel, listener);
            this.listenersByChannel.delete(channel);
        }
    }
}

/**
 * Builds a fake replacement for the `redis` module, backed by a single shared `FakeRedisServer` so that every
 * `createClient()` call within the mocked module behaves like a separate connection to the same Redis instance.
 * Intended for use with `vi.mock("redis", () => createFakeRedisModule())`.
 */
export function createFakeRedisModule(): { createClient: (opts?: any) => FakeRedisClient; RedisClient: any } {
    const server: FakeRedisServer = new FakeRedisServer();
    return {
        createClient: () => new FakeRedisClient(server),
        RedisClient: FakeRedisClient,
    };
}

/** Creates a single, already-connected fake client with its own private (not shared) backing server — for
 * tests that construct/inject a redis client directly rather than going through `createClient()`. */
export function createStandaloneFakeRedisClient(): FakeRedisClient {
    const client: FakeRedisClient = new FakeRedisClient(new FakeRedisServer());
    client.isOpen = true;
    client.isReady = true;
    return client;
}
