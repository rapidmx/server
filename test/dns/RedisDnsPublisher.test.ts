///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
// The server's `DnsPublisher` (spec 7.3): a version counter in Redis, bumped by every change to the DNS desired state, so each replica answers the DNS
// controller's long poll (`GET /internal/dns/v1/desired-state?since=<version>`) from the same count. A notice on the events Redis wakes the waiting polls of
// every replica at once; a poll of the counter every few seconds catches a notice that was missed.
import { resolveDnsPublisher } from "@rapidmx/restapi";
import {
    DNS_DESIRED_STATE_CHANGED_CHANNEL,
    DNS_DESIRED_STATE_VERSION_KEY,
    RedisDnsPublisher,
} from "../../src/dns/RedisDnsPublisher.js";
import { FakeRedisClient, FakeRedisServer } from "../helpers/FakeRedis.js";

/** Two replicas' publishers over one Redis: each has its own connections (the cache and the events datastore) to the same server. */
function replica(server: FakeRedisServer, options: ConstructorParameters<typeof RedisDnsPublisher>[0] = { pollMs: 25 }) {
    const cache = new FakeRedisClient(server);
    const events = new FakeRedisClient(server);
    const logger = { warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
    const publisher = new RedisDnsPublisher(options);
    (publisher as any).connectionManager = { connections: new Map<string, any>([["cache", cache], ["events", events]]) };
    (publisher as any).logger = logger;
    return { publisher, cache, events, logger };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("RedisDnsPublisher", () => {
    let server: FakeRedisServer;

    beforeEach(() => {
        server = new FakeRedisServer();
    });

    it("uses the names the spec gives the counter and the notice", () => {
        expect(DNS_DESIRED_STATE_VERSION_KEY).toBe("rapidmx:dns:desired-state:version");
        expect(DNS_DESIRED_STATE_CHANGED_CHANNEL).toBe("rapidmx:dns:desired-state:changed");
    });

    describe("version", () => {
        it("is 0 until something changes", async () => {
            expect(await replica(server).publisher.version()).toBe(0);
        });

        it("counts every change, whatever its scope, and every replica reads the same count", async () => {
            const a = replica(server);
            const b = replica(server);
            await a.publisher.changed({ scope: "domain", domainUid: "example.com" });
            await b.publisher.changed({ scope: "provider", providerUid: "dns-cloudflare-1a2b3c4d" });
            await a.publisher.changed({ scope: "operation", operationUid: "op-1" });
            await b.publisher.changed({ scope: "all" });
            expect(await a.publisher.version()).toBe(4);
            expect(await b.publisher.version()).toBe(4);
            expect(server.get(DNS_DESIRED_STATE_VERSION_KEY)).toBe("4");
        });

        it("reads a counter it can't make sense of as 0, so the controller learns the count the next change gives", async () => {
            const { publisher } = replica(server);
            for (const stored of ["x", "-3", "1.5", ""]) {
                server.set(DNS_DESIRED_STATE_VERSION_KEY, stored);
                expect(await publisher.version(), stored).toBe(0);
            }
        });

        it("names the Redis datastore it is missing, since nothing here can work without it", async () => {
            const { publisher } = replica(server);
            (publisher as any).connectionManager = { connections: new Map() };
            await expect(publisher.version()).rejects.toThrow(/'cache'/);
            await expect(publisher.changed({ scope: "all" })).rejects.toThrow(/'cache'/);
            (publisher as any).connectionManager = undefined;
            await expect(publisher.version()).rejects.toThrow(/'cache'/);
        });
    });

    describe("changed", () => {
        it("publishes the new version on the events datastore, for the replicas waiting on it", async () => {
            const { publisher } = replica(server);
            const heard: string[] = [];
            await new FakeRedisClient(server).subscribe(DNS_DESIRED_STATE_CHANGED_CHANNEL, (message) => heard.push(message));
            await publisher.changed({ scope: "all" });
            await publisher.changed({ scope: "all" });
            await sleep(5);
            expect(heard).toEqual(["1", "2"]);
        });

        it("fails when the counter can't be bumped, for the caller to log (the change is already saved)", async () => {
            const { publisher, cache } = replica(server);
            cache.incr = async () => {
                throw new Error("redis is down");
            };
            await expect(publisher.changed({ scope: "all" })).rejects.toThrow("redis is down");
        });

        it("fails when the notice can't be published, which the poll of the counter makes up for", async () => {
            const { publisher, events } = replica(server);
            events.publish = async () => {
                throw new Error("redis is down");
            };
            await expect(publisher.changed({ scope: "all" })).rejects.toThrow("redis is down");
            // The counter did move, so a waiting poll still sees it.
            expect(await publisher.version()).toBe(1);
        });
    });

    describe("waitForChange", () => {
        it("answers at once when the version is already past `since`: a change landing between the route's read and its wait", async () => {
            const { publisher } = replica(server);
            await publisher.changed({ scope: "all" });
            const started = Date.now();
            expect(await publisher.waitForChange(0, 5_000)).toBe(1);
            expect(Date.now() - started).toBeLessThan(1_000);
        });

        it("answers at once when the version is behind `since`: the counter was reset (Redis restarted without persistence)", async () => {
            const { publisher } = replica(server);
            const started = Date.now();
            expect(await publisher.waitForChange(7, 5_000)).toBe(0);
            expect(Date.now() - started).toBeLessThan(1_000);
        });

        it("wakes on the notice of a change another replica made, without waiting for the poll", async () => {
            const waiting = replica(server, { pollMs: 60_000 });
            const other = replica(server);
            const wait = waiting.publisher.waitForChange(0, 10_000);
            await sleep(20);
            await other.publisher.changed({ scope: "domain", domainUid: "example.com" });
            expect(await wait).toBe(1);
            await waiting.publisher.dispose();
        });

        it("catches a change whose notice was missed at its next poll of the counter", async () => {
            const { publisher } = replica(server, { pollMs: 25 });
            const wait = publisher.waitForChange(0, 10_000);
            await sleep(20);
            // A change with no notice: the publisher that made it died between the bump and the publish.
            server.incr(DNS_DESIRED_STATE_VERSION_KEY);
            expect(await wait).toBe(1);
            await publisher.dispose();
        });

        it("answers with the unchanged version when the time is up", async () => {
            const { publisher } = replica(server, { pollMs: 10 });
            await publisher.changed({ scope: "all" });
            const started = Date.now();
            expect(await publisher.waitForChange(1, 60)).toBe(1);
            expect(Date.now() - started).toBeGreaterThanOrEqual(50);
            await publisher.dispose();
        });

        it("stops waiting when the controller goes away, and does not wait at all for a signal that has already aborted", async () => {
            const { publisher } = replica(server, { pollMs: 60_000 });
            const abort = new AbortController();
            const wait = publisher.waitForChange(0, 60_000, abort.signal);
            await sleep(20);
            const started = Date.now();
            abort.abort();
            expect(await wait).toBe(0);
            expect(Date.now() - started).toBeLessThan(1_000);
            expect(await publisher.waitForChange(0, 60_000, AbortSignal.abort())).toBe(0);
            await publisher.dispose();
        });

        it("wakes every waiting poll on one change, over a single subscriber connection of its own", async () => {
            const { publisher, events } = replica(server, { pollMs: 60_000 });
            const duplicate = vi.spyOn(events, "duplicate");
            const polls = [publisher.waitForChange(0, 10_000), publisher.waitForChange(0, 10_000), publisher.waitForChange(0, 10_000)];
            await sleep(20);
            await publisher.changed({ scope: "all" });
            expect(await Promise.all(polls)).toEqual([1, 1, 1]);
            expect(duplicate).toHaveBeenCalledTimes(1);
            await publisher.dispose();
        });

        it("closes its subscriber connection when the ObjectFactory destroys it, and opens a new one for a later poll", async () => {
            const { publisher, events } = replica(server, { pollMs: 10 });
            const clients: FakeRedisClient[] = [];
            const duplicate = events.duplicate.bind(events);
            events.duplicate = () => {
                const client = duplicate();
                clients.push(client);
                return client;
            };
            await publisher.waitForChange(0, 30);
            expect(clients).toHaveLength(1);
            expect(clients[0].isOpen).toBe(true);
            await publisher.dispose();
            expect(clients[0].isOpen).toBe(false);
            await publisher.dispose();
            await publisher.waitForChange(0, 30);
            expect(clients).toHaveLength(2);
            await publisher.dispose();
        });

        it("still works by polling when the subscriber can't be opened, and says so once", async () => {
            const { publisher, events, logger } = replica(server, { pollMs: 10 });
            events.duplicate = () => {
                throw new Error("no events redis");
            };
            const wait = publisher.waitForChange(0, 10_000);
            await sleep(30);
            server.incr(DNS_DESIRED_STATE_VERSION_KEY);
            expect(await wait).toBe(1);
            expect(await publisher.waitForChange(1, 30)).toBe(1);
            expect(logger.warn).toHaveBeenCalledTimes(1);
            expect(logger.warn.mock.calls[0][0]).toMatch(/no events redis/);
            await publisher.dispose();
        });

        it("survives its subscriber connection failing: the connection has an error listener, as every duplicate of a client must", async () => {
            const { publisher, events, logger } = replica(server, { pollMs: 10 });
            let subscriber: FakeRedisClient | undefined;
            const duplicate = events.duplicate.bind(events);
            events.duplicate = () => (subscriber = duplicate());
            await publisher.waitForChange(0, 30);
            // An EventEmitter without an `error` listener throws on the event; for a real client that is an uncaught exception that ends the process.
            expect(() => subscriber!.emit("error", new Error("socket closed"))).not.toThrow();
            expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("socket closed"));
            await publisher.dispose();
        });

        it("closes the connection it opened when it can't subscribe, instead of leaving one more open for every poll", async () => {
            const { publisher, events } = replica(server, { pollMs: 10 });
            const clients: FakeRedisClient[] = [];
            const duplicate = events.duplicate.bind(events);
            events.duplicate = () => {
                const client = duplicate();
                client.subscribe = async () => {
                    throw new Error("NOPERM this user has no permissions to access one of the channels used as arguments");
                };
                clients.push(client);
                return client;
            };
            await publisher.waitForChange(0, 30);
            await publisher.waitForChange(0, 30);
            expect(clients.length).toBeGreaterThanOrEqual(2);
            expect(clients.map((client) => client.isOpen)).toEqual(clients.map(() => false));
            await publisher.dispose();
        });

        it("closes the connection it opened when it can't connect", async () => {
            const { publisher, events } = replica(server, { pollMs: 10 });
            const clients: FakeRedisClient[] = [];
            const duplicate = events.duplicate.bind(events);
            events.duplicate = () => {
                const client = duplicate();
                client.connect = async () => {
                    throw new Error("connection refused");
                };
                client.quit = vi.fn(async () => {
                    throw new Error("The client is closed");
                });
                vi.spyOn(client, "disconnect");
                clients.push(client);
                return client;
            };
            await publisher.waitForChange(0, 30);
            expect(clients).toHaveLength(1);
            // A client that can't quit is disconnected.
            expect(clients[0].disconnect).toHaveBeenCalled();
            await publisher.dispose();
        });

        it("answers on its own deadline while the subscriber is still connecting, and stops at once for an abort", async () => {
            const { publisher, events } = replica(server, { pollMs: 10 });
            const duplicate = events.duplicate.bind(events);
            events.duplicate = () => {
                const client = duplicate();
                // Connecting never finishes: node-redis retries for as long as Redis is down.
                client.connect = () => new Promise(() => undefined);
                return client;
            };
            const started = Date.now();
            expect(await publisher.waitForChange(0, 60)).toBe(0);
            expect(Date.now() - started).toBeLessThan(1_000);
            // The poll of the counter still sees a change.
            const wait = publisher.waitForChange(0, 10_000);
            await sleep(30);
            server.incr(DNS_DESIRED_STATE_VERSION_KEY);
            expect(await wait).toBe(1);
            const abort = new AbortController();
            const aborted = publisher.waitForChange(1, 60_000, abort.signal);
            await sleep(20);
            abort.abort();
            expect(await aborted).toBe(1);
        });

        it("doesn't hold the shutdown for a subscriber that is still connecting", async () => {
            const { publisher, events } = replica(server, { pollMs: 10 });
            let client: FakeRedisClient | undefined;
            const duplicate = events.duplicate.bind(events);
            events.duplicate = () => {
                client = duplicate();
                client.connect = () => new Promise(() => undefined);
                client.isOpen = true;
                return client;
            };
            await publisher.waitForChange(0, 30);
            await publisher.dispose();
            expect(client!.isOpen).toBe(false);
        });

        it("reads the counter again once the subscriber is up, for a notice published while it was connecting", async () => {
            const { publisher, events } = replica(server, { pollMs: 60_000 });
            let connected!: () => void;
            const duplicate = events.duplicate.bind(events);
            events.duplicate = () => {
                const client = duplicate();
                client.connect = () => new Promise((resolve) => (connected = () => resolve(client)));
                return client;
            };
            const wait = publisher.waitForChange(0, 10_000);
            await sleep(20);
            // No subscriber yet, so no notice reaches this poll; the counter is all there is.
            server.incr(DNS_DESIRED_STATE_VERSION_KEY);
            connected();
            expect(await wait).toBe(1);
            await publisher.dispose();
        });

        it("fails when the counter can't be read, for the controller to retry with its backoff", async () => {
            const { publisher, cache } = replica(server);
            cache.get = async () => {
                throw new Error("redis is down");
            };
            await expect(publisher.waitForChange(0, 1_000)).rejects.toThrow("redis is down");
        });
    });

    it("is what a server with a Redis resolves as its DnsPublisher", async () => {
        const { publisher } = replica(server);
        const factory = { newInstance: vi.fn(async () => publisher) } as any;
        expect(await resolveDnsPublisher(factory)).toBe(publisher);
        expect(factory.newInstance).toHaveBeenCalledWith("DnsPublisher", { name: "default" });
    });
});
