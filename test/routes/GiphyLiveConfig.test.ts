///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
// Giphy follows the integrations layer (spec 10.2, 11.3): the key and `giphy:enabled` are read through `HostConfig` at each search, so turning Giphy off or
// changing its key in the console applies at once, without a restart.
import { HostConfig } from "@rapidmx/restapi";
import { DEFAULT_GIPHY_API_KEY } from "../../src/config.defaults.js";
import { IntegrationsLayer } from "../../src/integrations/IntegrationsLayer.js";
import { BaseGiphySearchRoute } from "../../src/routes/BaseGiphySearchRoute.js";
import { keyringCipher, layeredConfig, logger, settingsRow } from "../helpers/integrations.js";

const giphyResponse = { ok: true, json: async () => ({ data: [] }) };

describe("BaseGiphySearchRoute with the integrations layer", () => {
    let conf: ReturnType<typeof layeredConfig>;
    let layer: IntegrationsLayer;
    let cipher: Awaited<ReturnType<typeof keyringCipher>>["cipher"];
    let uninstall: (() => void) | undefined;
    let fetchMock: ReturnType<typeof vi.fn>;
    let route: BaseGiphySearchRoute;
    let version = 0;

    const apply = (giphy?: { enabled?: boolean; apiKey?: string }) => layer.apply(settingsRow(cipher, { version: ++version, ...(giphy ? { giphy } : {}) }));
    const keyUsed = (call: number): string | null => new URL(fetchMock.mock.calls[call][0]).searchParams.get("api_key");

    beforeEach(async () => {
        version = 0;
        conf = layeredConfig({ giphy: { enabled: true, api_key: DEFAULT_GIPHY_API_KEY } });
        ({ cipher } = await keyringCipher(conf));
        layer = new IntegrationsLayer(conf, cipher, logger());
        uninstall = HostConfig.install(conf);
        fetchMock = vi.fn().mockResolvedValue(giphyResponse);
        vi.stubGlobal("fetch", fetchMock);
        route = new BaseGiphySearchRoute();
        // What the ObjectFactory injected at startup: the deployment's values, which must no longer decide.
        (route as any).apiKey = DEFAULT_GIPHY_API_KEY;
        (route as any).enabled = true;
    });

    afterEach(() => {
        uninstall?.();
        vi.unstubAllGlobals();
    });

    it("is not configured until the administrator sets a key, and searches with it from the next request once they do", async () => {
        await expect(route.search("cats")).rejects.toThrow(/not configured/i);
        expect(fetchMock).not.toHaveBeenCalled();

        apply({ apiKey: "admin-key-1" });
        await route.search("cats");
        expect(keyUsed(0)).toBe("admin-key-1");

        apply({ apiKey: "admin-key-2" });
        await route.search("cats");
        expect(keyUsed(1)).toBe("admin-key-2");
    });

    it("stops searching the moment the administrator turns Giphy off, key and all, and resumes when it is turned on", async () => {
        apply({ enabled: true, apiKey: "admin-key" });
        await route.search("cats");

        apply({ enabled: false, apiKey: "admin-key" });
        await expect(route.search("cats")).rejects.toThrow(/not configured/i);
        expect(fetchMock).toHaveBeenCalledTimes(1);

        apply({ enabled: true, apiKey: "admin-key" });
        await route.search("cats");
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("honours giphy:enabled set to false by the deployment, as text from the environment too, even with a key", async () => {
        conf.set("giphy:api_key", "deployment-key");
        await route.search("cats");
        expect(keyUsed(0)).toBe("deployment-key");

        for (const off of [false, "false", "0"]) {
            conf.set("giphy:enabled", off);
            await expect(route.search("cats")).rejects.toThrow(/not configured/i);
        }
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("falls back to the deployment's key once the administrator's is reset", async () => {
        conf.set("giphy:api_key", "deployment-key");
        apply({ apiKey: "admin-key" });
        await route.search("cats");
        apply();
        await route.search("cats");
        expect([keyUsed(0), keyUsed(1)]).toEqual(["admin-key", "deployment-key"]);
    });

    it("does not use the key it was started with once the host's configuration is installed", async () => {
        (route as any).apiKey = "stale-startup-key";
        await expect(route.search("cats")).rejects.toThrow(/not configured/i);
    });

    it("keeps reading the configuration it was started with in a process with no host", async () => {
        uninstall?.();
        uninstall = undefined;
        (route as any).apiKey = "startup-key";
        await route.search("cats");
        expect(keyUsed(0)).toBe("startup-key");
        (route as any).enabled = false;
        await expect(route.search("cats")).rejects.toThrow(/not configured/i);
    });
});
