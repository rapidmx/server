///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
// The change notice of the integrations (spec 11.2): `rapidmx:integrations:changed` on the events Redis, carrying the row's version, heard by every server copy.
import {
    INTEGRATIONS_CHANGED_CHANNEL,
    LocalIntegrationsChannel,
    RedisIntegrationsChannel,
} from "../../src/integrations/IntegrationsChannel.js";
import { FakeRedisClient, FakeRedisServer } from "../helpers/FakeRedis.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** One server copy's channel over the shared Redis. */
function replica(server: FakeRedisServer) {
    const events = new FakeRedisClient(server);
    const logger = { warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
    const channel = new RedisIntegrationsChannel();
    (channel as any).connectionManager = { connections: new Map<string, any>([["events", events]]) };
    (channel as any).logger = logger;
    return { channel, events, logger };
}

describe("LocalIntegrationsChannel", () => {
    it("tells the listeners of the process the version, until they stop listening", async () => {
        const channel = new LocalIntegrationsChannel();
        const heard: number[] = [];
        const stop = await channel.subscribe((version) => heard.push(version));
        await channel.publish(3);
        await stop();
        await channel.publish(4);
        expect(heard).toEqual([3]);
    });
});

describe("RedisIntegrationsChannel", () => {
    let server: FakeRedisServer;

    beforeEach(() => {
        server = new FakeRedisServer();
    });

    it("uses the name the spec gives the notice", () => {
        expect(INTEGRATIONS_CHANGED_CHANNEL).toBe("rapidmx:integrations:changed");
    });

    it("tells every copy the new version, the copy that made the change at once", async () => {
        const a = replica(server);
        const b = replica(server);
        const heardA: number[] = [];
        const heardB: number[] = [];
        await a.channel.subscribe((version) => heardA.push(version));
        await b.channel.subscribe((version) => heardB.push(version));

        await a.channel.publish(5);
        // The writer needn't wait for Redis to hear itself.
        expect(heardA).toContain(5);
        await sleep(20);
        expect(heardB).toEqual([5]);
        await a.channel.dispose();
        await b.channel.dispose();
    });

    it("hears a notice over one subscriber connection of its own, however many listen", async () => {
        const { channel, events } = replica(server);
        const duplicate = vi.spyOn(events, "duplicate");
        const heard: number[] = [];
        await channel.subscribe((version) => heard.push(version));
        await channel.subscribe((version) => heard.push(version * 10));
        expect(duplicate).toHaveBeenCalledTimes(1);
        server.publish(INTEGRATIONS_CHANGED_CHANNEL, "7");
        await sleep(20);
        expect(heard.sort((x, y) => x - y)).toEqual([7, 70]);
        await channel.dispose();
    });

    it("ignores a message that is not a version", async () => {
        const { channel } = replica(server);
        const heard: number[] = [];
        await channel.subscribe((version) => heard.push(version));
        for (const message of ["x", "-1", "1.5", ""]) {
            server.publish(INTEGRATIONS_CHANGED_CHANNEL, message);
        }
        await sleep(20);
        expect(heard).toEqual([]);
        await channel.dispose();
    });

    it("closes the subscriber connection when the last listener stops, and opens a new one for the next", async () => {
        const { channel, events } = replica(server);
        const clients: FakeRedisClient[] = [];
        const duplicate = events.duplicate.bind(events);
        events.duplicate = () => {
            const client = duplicate();
            clients.push(client);
            return client;
        };
        const stop = await channel.subscribe(() => undefined);
        expect(clients[0].isOpen).toBe(true);
        await stop();
        expect(clients[0].isOpen).toBe(false);
        await channel.subscribe(() => undefined);
        expect(clients).toHaveLength(2);
        await channel.dispose();
        expect(clients[1].isOpen).toBe(false);
    });

    it("rejects a subscription it can't make and closes the connection it opened, so the caller can try again", async () => {
        const { channel, events } = replica(server);
        const clients: FakeRedisClient[] = [];
        const duplicate = events.duplicate.bind(events);
        events.duplicate = () => {
            const client = duplicate();
            client.subscribe = async () => {
                throw new Error("NOPERM no permission for this channel");
            };
            clients.push(client);
            return client;
        };
        await expect(channel.subscribe(() => undefined)).rejects.toThrow(/NOPERM/);
        expect(clients[0].isOpen).toBe(false);
    });

    it("gives its subscriber connection an error listener, as every duplicate of a client must", async () => {
        const { channel, events, logger } = replica(server);
        let subscriber: FakeRedisClient | undefined;
        const duplicate = events.duplicate.bind(events);
        events.duplicate = () => (subscriber = duplicate());
        await channel.subscribe(() => undefined);
        expect(() => subscriber!.emit("error", new Error("socket closed"))).not.toThrow();
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("socket closed"));
        await channel.dispose();
    });

    it("names the Redis datastore it is missing, and still tells its own listeners about a change it could not announce", async () => {
        const { channel } = replica(server);
        const heard: number[] = [];
        await channel.subscribe((version) => heard.push(version));
        (channel as any).connectionManager = { connections: new Map() };
        await expect(channel.publish(2)).rejects.toThrow(/'events'/);
        expect(heard).toEqual([2]);
        await expect(replica(server).channel.subscribe(() => undefined)).resolves.toBeTypeOf("function");
        (channel as any).connectionManager = undefined;
        await expect(channel.publish(3)).rejects.toThrow(/'events'/);
    });
});
