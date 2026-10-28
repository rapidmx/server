///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
// The Autodiscover plugin being enabled or disabled changes the DNS records every domain needs (`autodiscover.<domain>`, `_autodiscover._tcp.<domain>`), and
// only takes effect when the plugin host restarts the server copies one by one. Each copy therefore announces the desired-state change once it runs with an
// Autodiscover state it hasn't announced yet, so the last copy to restart is the one the controller hears from last (spec 7.3, server step 4).
import { PluginRegistry } from "@rapidmx/restapi";
import { ConnectionManager } from "@rapidrest/service-core";
import {
    AUTODISCOVER_STATE_PREFIX,
    DEFAULT_SETTLE_MS,
    announceAutodiscoverState,
    autodiscoverFingerprint,
    startDnsPublishing,
} from "../../src/dns/AutodiscoverAnnouncement.js";
import { FakeRedisClient, FakeRedisServer } from "../helpers/FakeRedis.js";

const AUTODISCOVER = "@rapidmx/autodiscover-plugin";

const logger = () => ({ warn: vi.fn(), debug: vi.fn(), info: vi.fn() });

describe("Autodiscover announcement", () => {
    let server: FakeRedisServer;
    let redis: FakeRedisClient;
    let publisher: { changed: ReturnType<typeof vi.fn> };

    beforeEach(() => {
        server = new FakeRedisServer();
        redis = new FakeRedisClient(server);
        publisher = { changed: vi.fn(async () => undefined) };
        PluginRegistry.setLoaded([]);
    });

    afterAll(() => {
        PluginRegistry.setLoaded([]);
    });

    const enable = () => PluginRegistry.setLoaded([{ name: AUTODISCOVER, version: "1.0.0" }]);

    describe("autodiscoverFingerprint", () => {
        it("is the Autodiscover host the records point at, or off while the plugin isn't loaded", () => {
            expect(autodiscoverFingerprint("https://autodiscover.example.com/autodiscover")).toBe("off");
            enable();
            expect(autodiscoverFingerprint("https://autodiscover.example.com/autodiscover")).toBe("on:autodiscover.example.com");
            // The plugin is on but has no valid public URL yet: both records are published as manual.
            expect(autodiscoverFingerprint("")).toBe("on:");
            expect(autodiscoverFingerprint("not a url")).toBe("on:");
        });
    });

    describe("announceAutodiscoverState", () => {
        const options = (extra: Record<string, unknown> = {}) => ({
            publisher: publisher as any,
            redis: redis as any,
            copy: "mail-7d9f-abc12",
            publicUrl: "https://autodiscover.example.com/autodiscover",
            logger: logger(),
            ...extra,
        });

        it("announces a change to everything the first time a copy starts, and records what it announced under its own key", async () => {
            enable();
            expect(await announceAutodiscoverState(options())).toBe(true);
            expect(publisher.changed).toHaveBeenCalledTimes(1);
            expect(publisher.changed).toHaveBeenCalledWith({ scope: "all" });
            expect(server.get(`${AUTODISCOVER_STATE_PREFIX}mail-7d9f-abc12`)).toBe("on:autodiscover.example.com");
            expect(server.ttl(`${AUTODISCOVER_STATE_PREFIX}mail-7d9f-abc12`)).toBeGreaterThan(29 * 86_400);
        });

        it("announces nothing when the copy restarts into the state it announced last: a plugin restart for another plugin", async () => {
            enable();
            await announceAutodiscoverState(options());
            publisher.changed.mockClear();
            expect(await announceAutodiscoverState(options())).toBe(false);
            expect(publisher.changed).not.toHaveBeenCalled();
        });

        it("announces the plugin being disabled, and enabled again", async () => {
            enable();
            await announceAutodiscoverState(options());
            PluginRegistry.setLoaded([]);
            expect(await announceAutodiscoverState(options())).toBe(true);
            expect(server.get(`${AUTODISCOVER_STATE_PREFIX}mail-7d9f-abc12`)).toBe("off");
            enable();
            expect(await announceAutodiscoverState(options())).toBe(true);
            expect(publisher.changed).toHaveBeenCalledTimes(3);
        });

        it("announces a changed public URL, which moves the CNAME and SRV targets the same way", async () => {
            enable();
            await announceAutodiscoverState(options());
            expect(await announceAutodiscoverState(options({ publicUrl: "https://ad.example.net/autodiscover" }))).toBe(true);
            expect(server.get(`${AUTODISCOVER_STATE_PREFIX}mail-7d9f-abc12`)).toBe("on:ad.example.net");
        });

        it("makes every copy of a rolling restart announce, so the last copy to restart is heard after all the others run the new state", async () => {
            const stale = new FakeRedisClient(server);
            await announceAutodiscoverState(options({ redis: stale, copy: "mail-a" }));
            await announceAutodiscoverState(options({ redis: stale, copy: "mail-b" }));
            publisher.changed.mockClear();
            enable();
            // The plugin host restarts the copies one at a time; each runs the new state when it comes up.
            expect(await announceAutodiscoverState(options({ copy: "mail-a" }))).toBe(true);
            expect(await announceAutodiscoverState(options({ copy: "mail-b" }))).toBe(true);
            expect(publisher.changed).toHaveBeenCalledTimes(2);
        });

        it("does not record what it could not announce, so the next start tries again", async () => {
            enable();
            publisher.changed.mockRejectedValueOnce(new Error("redis is down"));
            const log = logger();
            expect(await announceAutodiscoverState(options({ logger: log }))).toBe(false);
            expect(server.get(`${AUTODISCOVER_STATE_PREFIX}mail-7d9f-abc12`)).toBeNull();
            expect(log.warn.mock.calls[0][0]).toMatch(/redis is down/);
            expect(await announceAutodiscoverState(options())).toBe(true);
        });

        it("announces when it can't read what it announced before, and carries on when it can't record it", async () => {
            enable();
            const broken: any = new FakeRedisClient(server);
            broken.get = async () => {
                throw new Error("read failed");
            };
            broken.set = async () => {
                throw new Error("write failed");
            };
            const log = logger();
            expect(await announceAutodiscoverState(options({ redis: broken, logger: log }))).toBe(true);
            expect(publisher.changed).toHaveBeenCalledTimes(1);
            expect(log.warn).toHaveBeenCalledTimes(2);
            expect(log.warn.mock.calls.map((call) => call[0]).join("\n")).toMatch(/read failed[\s\S]*write failed/);
        });

        it("announces on every start when there is no Redis to remember it in", async () => {
            enable();
            expect(await announceAutodiscoverState(options({ redis: undefined }))).toBe(true);
            expect(await announceAutodiscoverState(options({ redis: undefined }))).toBe(true);
            expect(publisher.changed).toHaveBeenCalledTimes(2);
        });
    });

    describe("startDnsPublishing", () => {
        function factory(extra: { publisher?: unknown; connections?: Map<string, unknown> | undefined } = {}) {
            const connections = extra.connections ?? new Map<string, unknown>([["cache", redis]]);
            return {
                newInstance: vi.fn(async (type: any) => {
                    if (type === "DnsPublisher") {
                        if (extra.publisher instanceof Error) {
                            throw extra.publisher;
                        }
                        return extra.publisher ?? publisher;
                    }
                    throw new Error(`unexpected ${String(type)}`);
                }),
                getInstance: vi.fn((type: any) => (type === ConnectionManager ? { connections } : undefined)),
            };
        }
        const config = (values: Record<string, unknown> = {}) => ({ get: (key: string) => values[key] });

        it("announces the Autodiscover state this copy runs with, remembered per copy by the plugin host's instance id", async () => {
            enable();
            const log = logger();
            await startDnsPublishing(
                factory(),
                config({ "mail:autodiscover:public_url": "https://autodiscover.example.com/", "system:plugins:instance_id": "mail-pod-1" }),
                log,
            );
            expect(publisher.changed).toHaveBeenCalledWith({ scope: "all" });
            expect(server.get(`${AUTODISCOVER_STATE_PREFIX}mail-pod-1`)).toBe("on:autodiscover.example.com");
        });

        it("falls back to the machine's host name for the copy, as the plugin host does", async () => {
            await startDnsPublishing(factory(), config(), logger());
            const keys = server.keys(`${AUTODISCOVER_STATE_PREFIX}*`);
            expect(keys).toHaveLength(1);
            expect(keys[0]).toBe(`${AUTODISCOVER_STATE_PREFIX}${(await import("node:os")).hostname()}`);
        });

        it("announces to the NullDnsPublisher restapi falls back to on a server that registers none, which is no failure", async () => {
            const log = logger();
            await expect(startDnsPublishing(factory({ publisher: new Error("No class found with name: DnsPublisher") }), config(), log)).resolves.toBeUndefined();
        });

        it("uses no remembered state when the cache datastore isn't connected", async () => {
            enable();
            await startDnsPublishing(factory({ connections: new Map() }), config(), logger());
            expect(publisher.changed).toHaveBeenCalledTimes(1);
            expect(server.keys("*")).toEqual([]);
        });

        describe("after a rollout", () => {
            beforeEach(() => {
                vi.useFakeTimers();
            });

            afterEach(() => {
                vi.useRealTimers();
            });

            it("announces a second time once the rollout has moved on, since the first may have been answered by an old pod still in the Service", async () => {
                enable();
                await startDnsPublishing(factory(), config({ "system:plugins:instance_id": "mail-pod-1" }), logger());
                expect(publisher.changed).toHaveBeenCalledTimes(1);
                await vi.advanceTimersByTimeAsync(DEFAULT_SETTLE_MS - 1);
                expect(publisher.changed).toHaveBeenCalledTimes(1);
                await vi.advanceTimersByTimeAsync(1);
                expect(publisher.changed).toHaveBeenCalledTimes(2);
                expect(publisher.changed).toHaveBeenLastCalledWith({ scope: "all" });
                // Only the once.
                await vi.advanceTimersByTimeAsync(10 * DEFAULT_SETTLE_MS);
                expect(publisher.changed).toHaveBeenCalledTimes(2);
            });

            it("announces nothing again for a copy that announced nothing", async () => {
                enable();
                await startDnsPublishing(factory(), config({ "system:plugins:instance_id": "mail-pod-1" }), logger());
                await vi.advanceTimersByTimeAsync(DEFAULT_SETTLE_MS);
                publisher.changed.mockClear();
                await startDnsPublishing(factory(), config({ "system:plugins:instance_id": "mail-pod-1" }), logger());
                await vi.advanceTimersByTimeAsync(10 * DEFAULT_SETTLE_MS);
                expect(publisher.changed).not.toHaveBeenCalled();
            });

            it("says it when the second announcement fails, and doesn't throw", async () => {
                enable();
                const log = logger();
                await startDnsPublishing(factory(), config({ "system:plugins:instance_id": "mail-pod-1" }), log, 1000);
                publisher.changed.mockRejectedValueOnce(new Error("redis is down"));
                await vi.advanceTimersByTimeAsync(1000);
                expect(log.warn.mock.calls[0][0]).toMatch(/again.*redis is down/);
            });

            it("does not keep a stopping process alive for the second announcement", async () => {
                enable();
                const unref = vi.spyOn(globalThis, "setTimeout");
                await startDnsPublishing(factory(), config(), logger());
                const timer = unref.mock.results.at(-1)!.value;
                expect(timer.hasRef()).toBe(false);
            });
        });

        it("never throws: a server whose announcement fails still starts", async () => {
            const log = logger();
            const failing = { ...factory(), newInstance: vi.fn(async () => { throw new Error("boom"); }), getInstance: vi.fn(() => { throw new Error("no manager"); }) };
            await expect(startDnsPublishing(failing, config(), log)).resolves.toBeUndefined();
            expect(log.warn).toHaveBeenCalled();
        });
    });
});
