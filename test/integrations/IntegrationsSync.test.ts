///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
// Keeping the integrations layer current (spec 11.2): a copy rebuilds the layer when the change notice arrives, and catches up within a minute by comparing
// the row's version when it missed one.
import { IntegrationsLayer } from "../../src/integrations/IntegrationsLayer.js";
import { LocalIntegrationsChannel, type IntegrationsChannel } from "../../src/integrations/IntegrationsChannel.js";
import { IntegrationsSync } from "../../src/integrations/IntegrationsSync.js";
import { UnreadableSecrets } from "../../src/secrets/UnreadableSecrets.js";
import { keyringCipher, layeredConfig, logger, settingsRow } from "../helpers/integrations.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("IntegrationsSync", () => {
    let conf: ReturnType<typeof layeredConfig>;
    let cipher: Awaited<ReturnType<typeof keyringCipher>>["cipher"];
    let log: ReturnType<typeof logger>;
    let layer: IntegrationsLayer;
    let channel: LocalIntegrationsChannel;
    let row: any;
    let read: ReturnType<typeof vi.fn>;
    let sync: IntegrationsSync;

    const make = (options: { channel?: IntegrationsChannel; pollMs?: number } = {}) =>
        new IntegrationsSync({ layer, read: read as any, channel: options.channel ?? channel, logger: log, pollMs: options.pollMs ?? 40 });

    beforeEach(async () => {
        UnreadableSecrets.reset();
        conf = layeredConfig({ giphy: { api_key: "deployment-key" } });
        ({ cipher } = await keyringCipher(conf));
        log = logger();
        layer = new IntegrationsLayer(conf, cipher, log);
        channel = new LocalIntegrationsChannel();
        row = settingsRow(cipher, { version: 1, giphy: { apiKey: "key-1" } });
        read = vi.fn(async () => row);
        sync = make();
    });

    afterEach(async () => {
        await sync.stop();
    });

    it("applies the row at start", async () => {
        await sync.start();
        expect(conf.get("giphy:api_key")).toBe("key-1");
        expect(layer.version).toBe(1);
    });

    it("rebuilds the layer when the change notice arrives, without a restart", async () => {
        await sync.start();
        row = settingsRow(cipher, { version: 2, giphy: { apiKey: "key-2" } });
        await channel.publish(2);
        await sleep(20);
        expect(conf.get("giphy:api_key")).toBe("key-2");
        expect(layer.version).toBe(2);
    });

    it("catches up on its timer when a notice was missed", async () => {
        await sync.start();
        row = settingsRow(cipher, { version: 2, giphy: { apiKey: "key-2" } });
        await sleep(120);
        expect(conf.get("giphy:api_key")).toBe("key-2");
    });

    it("does not rebuild the layer for a row version it already holds", async () => {
        const apply = vi.spyOn(layer, "apply");
        await sync.start();
        expect(apply).toHaveBeenCalledTimes(1);
        await channel.publish(1);
        await sleep(100);
        expect(apply).toHaveBeenCalledTimes(1);
    });

    it("looks again while a secret can't be read, so a key that is loaded later is used without a change to the row", async () => {
        const other = layeredConfig({});
        const { cipher: elsewhere } = await keyringCipher(other);
        row = settingsRow(elsewhere, { version: 1, giphy: { apiKey: "lost-key" } });
        await sync.start();
        expect(conf.get("giphy:api_key")).toBe("deployment-key");

        // The keyring now has the key (the same row, the same version).
        row = settingsRow(cipher, { version: 1, giphy: { apiKey: "found-key" } });
        await sleep(120);
        expect(conf.get("giphy:api_key")).toBe("found-key");
    });

    it("runs one refresh at a time and reads again once if a notice came in meanwhile", async () => {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        read.mockImplementationOnce(async () => {
            await gate;
            return row;
        });
        const first = sync.refresh();
        row = settingsRow(cipher, { version: 2, giphy: { apiKey: "key-2" } });
        const second = sync.refresh();
        release();
        await Promise.all([first, second]);
        expect(read).toHaveBeenCalledTimes(2);
        expect(layer.version).toBe(2);
    });

    it("keeps the layer it has when the row can't be read, says so once for the same failure, and recovers", async () => {
        await sync.start();
        read.mockRejectedValue(new Error("datastore down"));
        await sleep(150);
        expect(conf.get("giphy:api_key")).toBe("key-1");
        const failures = log.warn.mock.calls.filter((call) => String(call[0]).includes("datastore down"));
        expect(failures).toHaveLength(1);

        read.mockResolvedValue(settingsRow(cipher, { version: 3, giphy: { apiKey: "key-3" } }));
        await sleep(100);
        expect(conf.get("giphy:api_key")).toBe("key-3");
        // A later failure is said again.
        read.mockRejectedValue(new Error("datastore down"));
        await sleep(100);
        expect(log.warn.mock.calls.filter((call) => String(call[0]).includes("datastore down"))).toHaveLength(2);
    });

    it("still works by its timer when the notice can't be heard, says so once, and subscribes when it can", async () => {
        let available = false;
        const flaky: IntegrationsChannel = {
            publish: async () => undefined,
            subscribe: async (listener) => {
                if (!available) {
                    throw new Error("events redis down");
                }
                return channel.subscribe(listener);
            },
        };
        sync = make({ channel: flaky });
        await sync.start();
        await sleep(100);
        expect(log.warn.mock.calls.filter((call) => String(call[0]).includes("events redis down"))).toHaveLength(1);

        available = true;
        await sleep(80);
        row = settingsRow(cipher, { version: 2, giphy: { apiKey: "key-2" } });
        // Heard at once now, not at the next tick.
        await channel.publish(2);
        await sleep(15);
        expect(conf.get("giphy:api_key")).toBe("key-2");
    });

    it("starts, polls and stops while the subscription never settles (a Redis that can't be reached)", async () => {
        let unsubscribed = false;
        let settle!: (stop: () => Promise<void>) => void;
        const hanging: IntegrationsChannel = {
            publish: async () => undefined,
            subscribe: () => new Promise((resolve) => (settle = resolve)),
        };
        sync = make({ channel: hanging });
        // Not held up by the subscriber connection.
        await Promise.race([sync.start(), sleep(1000).then(() => Promise.reject(new Error("start() waited for the subscription")))]);
        expect(conf.get("giphy:api_key")).toBe("key-1");

        // The timer covers the notice that can't be heard.
        row = settingsRow(cipher, { version: 2, giphy: { apiKey: "key-2" } });
        await sleep(120);
        expect(conf.get("giphy:api_key")).toBe("key-2");

        // Stopping doesn't wait for it either, and closes it if it ever does connect.
        await Promise.race([sync.stop(), sleep(1000).then(() => Promise.reject(new Error("stop() waited for the subscription")))]);
        settle(async () => void (unsubscribed = true));
        await sleep(10);
        expect(unsubscribed).toBe(true);
    });

    it("works without a channel, by its timer alone", async () => {
        sync = new IntegrationsSync({ layer, read: read as any, logger: log, pollMs: 40 });
        await sync.start();
        row = settingsRow(cipher, { version: 2, giphy: { apiKey: "key-2" } });
        await sleep(120);
        expect(conf.get("giphy:api_key")).toBe("key-2");
    });

    it("stops listening and polling when it is stopped", async () => {
        await sync.start();
        await sync.stop();
        const calls = read.mock.calls.length;
        await channel.publish(9);
        await sleep(120);
        expect(read.mock.calls.length).toBe(calls);
        await sync.stop();
    });
});
