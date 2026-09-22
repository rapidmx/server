///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
import config from "../../src/config.mongo.js";
import { ObjectFactory } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import { DohDnssecDnsResolver } from "../../src/dns/DohDnssecDnsResolver.js";

function fakeFetchResponse(body: unknown, ok = true, status = 200): Response {
    return {
        ok,
        status,
        json: async () => body,
    } as Response;
}

describe("DohDnssecDnsResolver Tests", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    describe("resolveTxt()", () => {
        it("returns a single-chunk TXT record's value unwrapped from its quotes.", async () => {
            const fetchMock = vi.fn().mockResolvedValue(
                fakeFetchResponse({
                    Status: 0,
                    AD: true,
                    Answer: [{ name: "example.com.", type: 16, TTL: 300, data: '"v=rmx1; foo=bar"' }],
                }),
            );
            vi.stubGlobal("fetch", fetchMock);

            const resolver = new DohDnssecDnsResolver();
            const result = await resolver.resolveTxt("example.com");

            expect(result).toEqual([["v=rmx1; foo=bar"]]);
            const [url, init] = fetchMock.mock.calls[0];
            expect(url).toContain("name=example.com");
            expect(url).toContain("type=16");
            expect((init.headers as Record<string, string>).accept).toBe("application/dns-json");
        });

        it("rejoins a multi-chunk TXT record into separate array entries, unescaping backslash-escaped quotes.", async () => {
            vi.stubGlobal(
                "fetch",
                vi.fn().mockResolvedValue(
                    fakeFetchResponse({
                        Status: 0,
                        AD: true,
                        Answer: [{ name: "example.com.", type: 16, TTL: 300, data: '"chunk \\"one\\"" "chunk two"' }],
                    }),
                ),
            );

            const resolver = new DohDnssecDnsResolver();
            const result = await resolver.resolveTxt("example.com");

            expect(result).toEqual([['chunk "one"', "chunk two"]]);
        });

        it("throws when the DNS response Status indicates failure (e.g. NXDOMAIN).", async () => {
            vi.stubGlobal("fetch", vi.fn().mockResolvedValue(fakeFetchResponse({ Status: 3 })));

            const resolver = new DohDnssecDnsResolver();
            await expect(resolver.resolveTxt("nonexistent.example.com")).rejects.toThrow(/status 3/);
        });

        it("throws when DNSSEC validation was not confirmed (AD flag missing) under the default fail-closed setting.", async () => {
            vi.stubGlobal(
                "fetch",
                vi.fn().mockResolvedValue(
                    fakeFetchResponse({
                        Status: 0,
                        AD: false,
                        Answer: [{ name: "example.com.", type: 16, TTL: 300, data: '"v=rmx1"' }],
                    }),
                ),
            );

            const resolver = new DohDnssecDnsResolver();
            await expect(resolver.resolveTxt("example.com")).rejects.toThrow(/DNSSEC validation/);
        });

        it("does not require the AD flag once configured with require_ad: false.", async () => {
            vi.stubGlobal(
                "fetch",
                vi.fn().mockResolvedValue(
                    fakeFetchResponse({
                        Status: 0,
                        AD: false,
                        Answer: [{ name: "example.com.", type: 16, TTL: 300, data: '"v=rmx1"' }],
                    }),
                ),
            );

            const resolver = new DohDnssecDnsResolver();
            (resolver as unknown as { requireAd: boolean }).requireAd = false;
            const result = await resolver.resolveTxt("example.com");
            expect(result).toEqual([["v=rmx1"]]);
        });

        it("throws when there are no TXT answers at all.", async () => {
            vi.stubGlobal("fetch", vi.fn().mockResolvedValue(fakeFetchResponse({ Status: 0, AD: true, Answer: [] })));

            const resolver = new DohDnssecDnsResolver();
            await expect(resolver.resolveTxt("example.com")).rejects.toThrow(/no records/);
        });

        it("throws when the response has no Answer field at all (e.g. an authoritative NODATA response).", async () => {
            vi.stubGlobal("fetch", vi.fn().mockResolvedValue(fakeFetchResponse({ Status: 0, AD: true })));

            const resolver = new DohDnssecDnsResolver();
            await expect(resolver.resolveTxt("example.com")).rejects.toThrow(/no records/);
        });

        it("treats an unquoted TXT data value as a single chunk rather than throwing.", async () => {
            vi.stubGlobal(
                "fetch",
                vi.fn().mockResolvedValue(
                    fakeFetchResponse({
                        Status: 0,
                        AD: true,
                        Answer: [{ name: "example.com.", type: 16, TTL: 300, data: "unquoted value" }],
                    }),
                ),
            );

            const resolver = new DohDnssecDnsResolver();
            const result = await resolver.resolveTxt("example.com");
            expect(result).toEqual([["unquoted value"]]);
        });

        it("throws when the HTTP request to the DoH endpoint itself fails.", async () => {
            vi.stubGlobal("fetch", vi.fn().mockResolvedValue(fakeFetchResponse(undefined, false, 503)));

            const resolver = new DohDnssecDnsResolver();
            await expect(resolver.resolveTxt("example.com")).rejects.toThrow(/HTTP 503/);
        });

        it("filters out answers of a different record type than requested (e.g. a CNAME chased along the way).", async () => {
            vi.stubGlobal(
                "fetch",
                vi.fn().mockResolvedValue(
                    fakeFetchResponse({
                        Status: 0,
                        AD: true,
                        Answer: [
                            { name: "example.com.", type: 5, TTL: 300, data: "alias.example.com." },
                            { name: "alias.example.com.", type: 16, TTL: 300, data: '"real value"' },
                        ],
                    }),
                ),
            );

            const resolver = new DohDnssecDnsResolver();
            const result = await resolver.resolveTxt("example.com");
            expect(result).toEqual([["real value"]]);
        });
    });

    describe("resolveMx()", () => {
        it("parses priority and exchange, stripping the trailing root dot.", async () => {
            vi.stubGlobal(
                "fetch",
                vi.fn().mockResolvedValue(
                    fakeFetchResponse({
                        Status: 0,
                        AD: true,
                        Answer: [{ name: "example.com.", type: 15, TTL: 300, data: "10 mail.example.com." }],
                    }),
                ),
            );

            const resolver = new DohDnssecDnsResolver();
            const result = await resolver.resolveMx("example.com");
            expect(result).toEqual([{ priority: 10, exchange: "mail.example.com" }]);
        });
    });

    describe("resolveCname()", () => {
        it("parses the target hostname, stripping the trailing root dot.", async () => {
            vi.stubGlobal(
                "fetch",
                vi.fn().mockResolvedValue(
                    fakeFetchResponse({
                        Status: 0,
                        AD: true,
                        Answer: [{ name: "autodiscover.example.com.", type: 5, TTL: 300, data: "mail.example.com." }],
                    }),
                ),
            );

            const resolver = new DohDnssecDnsResolver();
            const result = await resolver.resolveCname("autodiscover.example.com");
            expect(result).toEqual(["mail.example.com"]);
            const [url] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
            expect(url).toContain("type=5");
        });
    });

    describe("resolveSrv()", () => {
        it("parses priority, weight, port and target, stripping the trailing root dot.", async () => {
            vi.stubGlobal(
                "fetch",
                vi.fn().mockResolvedValue(
                    fakeFetchResponse({
                        Status: 0,
                        AD: true,
                        Answer: [{ name: "_autodiscover._tcp.example.com.", type: 33, TTL: 300, data: "0 0 443 mail.example.com." }],
                    }),
                ),
            );

            const resolver = new DohDnssecDnsResolver();
            const result = await resolver.resolveSrv("_autodiscover._tcp.example.com");
            expect(result).toEqual([{ priority: 0, weight: 0, port: 443, target: "mail.example.com" }]);
            const [url] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
            expect(url).toContain("type=33");
        });
    });

    it("reads its endpoint/require_ad/timeout_ms from config when constructed via the DI container.", async () => {
        config.set("mail:dns:doh:endpoint", "https://dns.example.net/dns-query");
        const objectFactory = new ObjectFactory(config, new Logger());
        const resolver = await objectFactory.newInstance<DohDnssecDnsResolver>(DohDnssecDnsResolver);

        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue(fakeFetchResponse({ Status: 0, AD: true, Answer: [{ name: "x.", type: 16, TTL: 1, data: '"x"' }] })),
        );
        await resolver.resolveTxt("example.com");

        const [url] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
        expect(url).toContain("https://dns.example.net/dns-query");
    });
});
