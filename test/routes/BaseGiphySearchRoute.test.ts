///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
import config from "../../src/config.mongo.js";
import { ObjectFactory } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import { BaseGiphySearchRoute, clampLimit } from "../../src/routes/BaseGiphySearchRoute.js";
import { DEFAULT_GIPHY_API_KEY } from "../../src/config.defaults.js";

function giphyApiResponse(gifs: { id: string; title: string }[]) {
    return {
        ok: true,
        json: async () => ({
            data: gifs.map((gif) => ({
                id: gif.id,
                title: gif.title,
                images: {
                    fixed_width_small: { url: `https://media.giphy.com/${gif.id}/small.gif` },
                    fixed_width: { url: `https://media.giphy.com/${gif.id}/medium.gif` },
                    original: { url: `https://media.giphy.com/${gif.id}/original.gif` },
                },
            })),
        }),
    };
}

describe("BaseGiphySearchRoute Tests", () => {
    const objectFactory: ObjectFactory = new ObjectFactory(config, Logger());

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it("throws INTERNAL_ERROR when no API key is configured (the default — giphy:api_key is unset).", async () => {
        const route = objectFactory.newInstance<BaseGiphySearchRoute>(BaseGiphySearchRoute, { initialize: false });

        await expect(route.search("cats")).rejects.toThrow(/not configured/i);
    });

    it("searches Giphy and maps the response down to {id, previewUrl, url, title}.", async () => {
        const route = objectFactory.newInstance<BaseGiphySearchRoute>(BaseGiphySearchRoute, { initialize: false });
        (route as any).apiKey = "test-key";
        const fetchMock = vi.fn().mockResolvedValue(giphyApiResponse([{ id: "g1", title: "Cat" }]));
        vi.stubGlobal("fetch", fetchMock);

        const result = await route.search("cats");

        expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("https://api.giphy.com/v1/gifs/search?"), {
            signal: expect.any(AbortSignal),
        });
        expect(fetchMock.mock.calls[0][0]).toContain("api_key=test-key");
        expect(fetchMock.mock.calls[0][0]).toContain("q=cats");
        expect(result).toEqual([
            { id: "g1", previewUrl: "https://media.giphy.com/g1/small.gif", url: "https://media.giphy.com/g1/original.gif", title: "Cat" },
        ]);
    });

    it("falls back to Giphy's trending feed when no query is given.", async () => {
        const route = objectFactory.newInstance<BaseGiphySearchRoute>(BaseGiphySearchRoute, { initialize: false });
        (route as any).apiKey = "test-key";
        const fetchMock = vi.fn().mockResolvedValue(giphyApiResponse([]));
        vi.stubGlobal("fetch", fetchMock);

        await route.search(undefined, undefined);

        expect(fetchMock.mock.calls[0][0]).toContain("https://api.giphy.com/v1/gifs/trending?");
    });

    it("falls back to Giphy's trending feed when the query is blank/whitespace.", async () => {
        const route = objectFactory.newInstance<BaseGiphySearchRoute>(BaseGiphySearchRoute, { initialize: false });
        (route as any).apiKey = "test-key";
        const fetchMock = vi.fn().mockResolvedValue(giphyApiResponse([]));
        vi.stubGlobal("fetch", fetchMock);

        await route.search("   ");

        expect(fetchMock.mock.calls[0][0]).toContain("/trending?");
    });

    it("clamps an oversized limit down to the maximum.", async () => {
        const route = objectFactory.newInstance<BaseGiphySearchRoute>(BaseGiphySearchRoute, { initialize: false });
        (route as any).apiKey = "test-key";
        const fetchMock = vi.fn().mockResolvedValue(giphyApiResponse([]));
        vi.stubGlobal("fetch", fetchMock);

        await route.search("cats", "9999");

        expect(fetchMock.mock.calls[0][0]).toContain("limit=50");
    });

    it("treats the checked-in placeholder API key as unset.", async () => {
        const route = objectFactory.newInstance<BaseGiphySearchRoute>(BaseGiphySearchRoute, { initialize: false });
        (route as any).apiKey = DEFAULT_GIPHY_API_KEY;
        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);

        await expect(route.search("cats")).rejects.toThrow(/not configured/i);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("clamps limit to 1..50 and falls back to the default for a non-number.", () => {
        expect(clampLimit(undefined)).toBe(24);
        expect(clampLimit("abc")).toBe(24);
        expect(clampLimit("")).toBe(24);
        expect(clampLimit("0")).toBe(1);
        expect(clampLimit("-5")).toBe(1);
        expect(clampLimit("10")).toBe(10);
        expect(clampLimit("9999")).toBe(50);
    });

    it("declares a per-user rate limit on search.", () => {
        const route = Reflect.getMetadata("rrst:route", BaseGiphySearchRoute.prototype, "search");
        expect(route.rateLimit).toMatchObject({ perUser: true, maxAttempts: 300, windowSeconds: 60 });
    });

    it("uses the default limit when none is given.", async () => {
        const route = objectFactory.newInstance<BaseGiphySearchRoute>(BaseGiphySearchRoute, { initialize: false });
        (route as any).apiKey = "test-key";
        const fetchMock = vi.fn().mockResolvedValue(giphyApiResponse([]));
        vi.stubGlobal("fetch", fetchMock);

        await route.search("cats");

        expect(fetchMock.mock.calls[0][0]).toContain("limit=24");
    });

    it("throws INTERNAL_ERROR when Giphy's own response is not ok.", async () => {
        const route = objectFactory.newInstance<BaseGiphySearchRoute>(BaseGiphySearchRoute, { initialize: false });
        (route as any).apiKey = "test-key";
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));

        await expect(route.search("cats")).rejects.toThrow(/could not reach giphy/i);
    });

    it("throws INTERNAL_ERROR when the network request itself fails.", async () => {
        const route = objectFactory.newInstance<BaseGiphySearchRoute>(BaseGiphySearchRoute, { initialize: false });
        (route as any).apiKey = "test-key";
        vi.stubGlobal(
            "fetch",
            vi.fn().mockRejectedValue(new TypeError("network down")),
        );

        await expect(route.search("cats")).rejects.toThrow(/could not reach giphy/i);
    });

    it("falls back through fixed_width_small -> fixed_width -> original for the preview URL.", async () => {
        const route = objectFactory.newInstance<BaseGiphySearchRoute>(BaseGiphySearchRoute, { initialize: false });
        (route as any).apiKey = "test-key";
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({
                    data: [{ id: "g1", title: "Cat", images: { original: { url: "https://media.giphy.com/g1/original.gif" } } }],
                }),
            }),
        );

        const result = await route.search("cats");

        expect(result[0].previewUrl).toBe("https://media.giphy.com/g1/original.gif");
    });
});
