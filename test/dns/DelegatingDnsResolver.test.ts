///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
// The DNS resolver the server registers (spec 11.3): which resolver answers, and where the DoH one asks, follow the integrations layer at each lookup, so
// changing them in the console applies without a restart.
import { HostConfig, NodeDnsResolver } from "@rapidmx/restapi";
import { DelegatingDnsResolver } from "../../src/dns/DelegatingDnsResolver.js";
import { DohDnssecDnsResolver } from "../../src/dns/DohDnssecDnsResolver.js";
import { IntegrationsLayer } from "../../src/integrations/IntegrationsLayer.js";
import { keyringCipher, layeredConfig, logger, settingsRow } from "../helpers/integrations.js";

/** A DoH answer with one TXT record. */
function dohAnswer(data: string): Response {
    return { ok: true, status: 200, json: async () => ({ Status: 0, AD: true, Answer: [{ name: "example.com.", type: 16, TTL: 60, data: `"${data}"` }] }) } as Response;
}

describe("DelegatingDnsResolver", () => {
    let conf: ReturnType<typeof layeredConfig>;
    let layer: IntegrationsLayer;
    let cipher: Awaited<ReturnType<typeof keyringCipher>>["cipher"];
    let uninstall: (() => void) | undefined;
    let node: NodeDnsResolver;
    let doh: DohDnssecDnsResolver;

    /** A resolver built as the ObjectFactory builds one: its own injected resolvers, here the doubles. */
    const build = (): DelegatingDnsResolver => {
        const resolver = new DelegatingDnsResolver();
        (resolver as any).node = node;
        (resolver as any).doh = doh;
        (resolver as any).configuredMode = conf.get("mail:dns:resolver");
        return resolver;
    };

    beforeEach(async () => {
        conf = layeredConfig({ mail: { dns: { resolver: "node" } } });
        ({ cipher } = await keyringCipher(conf));
        layer = new IntegrationsLayer(conf, cipher, logger());
        node = new NodeDnsResolver();
        doh = new DohDnssecDnsResolver();
        vi.spyOn(node, "resolveTxt").mockResolvedValue([["from-node"]]);
        vi.spyOn(node, "resolveMx").mockResolvedValue([{ priority: 10, exchange: "mx.node.example" }]);
        vi.spyOn(node, "resolveCname").mockResolvedValue(["node.example"]);
        vi.spyOn(node, "resolveSrv").mockResolvedValue([{ priority: 1, weight: 1, port: 443, target: "srv.node.example" }]);
        vi.spyOn(node, "resolveAddresses").mockResolvedValue(["192.0.2.1"]);
        uninstall = HostConfig.install(conf);
    });

    afterEach(() => {
        uninstall?.();
        vi.unstubAllGlobals();
    });

    it("answers with Node's resolver while the deployment's mode is node, for every kind of lookup", async () => {
        const resolver = build();
        expect(await resolver.resolveTxt("example.com")).toEqual([["from-node"]]);
        expect(await resolver.resolveMx("example.com")).toEqual([{ priority: 10, exchange: "mx.node.example" }]);
        expect(await resolver.resolveCname("example.com")).toEqual(["node.example"]);
        expect(await resolver.resolveSrv("example.com")).toEqual([{ priority: 1, weight: 1, port: 443, target: "srv.node.example" }]);
    });

    it("answers the address lookup, which DNS publishing's checks need, with the resolver in force", async () => {
        const fetchMock = vi.fn().mockImplementation(async (url: string) =>
            ({ ok: true, status: 200, json: async () => ({ Status: 0, AD: true, Answer: [{ name: "x.", type: url.includes("type=28") ? 28 : 1, TTL: 60, data: url.includes("type=28") ? "2001:db8::1" : "192.0.2.9" }] }) }) as Response,
        );
        vi.stubGlobal("fetch", fetchMock);
        const resolver = build();
        expect(await resolver.resolveAddresses("auth.example.com")).toEqual(["192.0.2.1"]);
        layer.apply(settingsRow(cipher, { version: 1, dnsResolver: { mode: "doh-dnssec" } }));
        expect(await resolver.resolveAddresses("auth.example.com")).toEqual(["192.0.2.9", "2001:db8::1"]);
    });

    it("switches to the DoH resolver when the administrator changes the mode, and back when it is reset, without a restart", async () => {
        const fetchMock = vi.fn().mockResolvedValue(dohAnswer("from-doh"));
        vi.stubGlobal("fetch", fetchMock);
        const resolver = build();
        expect(await resolver.resolveTxt("example.com")).toEqual([["from-node"]]);

        layer.apply(settingsRow(cipher, { version: 1, dnsResolver: { mode: "doh-dnssec" } }));
        expect(await resolver.resolveTxt("example.com")).toEqual([["from-doh"]]);
        expect(fetchMock).toHaveBeenCalledTimes(1);

        layer.apply(undefined);
        expect(await resolver.resolveTxt("example.com")).toEqual([["from-node"]]);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("asks the DoH endpoint the administrator set, at each lookup", async () => {
        const fetchMock = vi.fn().mockResolvedValue(dohAnswer("from-doh"));
        vi.stubGlobal("fetch", fetchMock);
        const resolver = build();

        layer.apply(settingsRow(cipher, { version: 1, dnsResolver: { mode: "doh-dnssec", dohEndpoint: "https://doh.one.example/dns-query" } }));
        await resolver.resolveTxt("example.com");
        layer.apply(settingsRow(cipher, { version: 2, dnsResolver: { mode: "doh-dnssec", dohEndpoint: "https://doh.two.example/dns-query" } }));
        await resolver.resolveTxt("example.com");

        expect(fetchMock.mock.calls[0][0]).toMatch(/^https:\/\/doh\.one\.example\/dns-query\?name=example\.com/);
        expect(fetchMock.mock.calls[1][0]).toMatch(/^https:\/\/doh\.two\.example\/dns-query\?name=example\.com/);
    });

    it("starts with the deployment's DoH mode when that is what it configures", async () => {
        conf.set("mail:dns:resolver", "doh-dnssec");
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(dohAnswer("from-doh")));
        expect(await build().resolveTxt("example.com")).toEqual([["from-doh"]]);
    });

    it("treats a mode it doesn't know as Node's resolver", async () => {
        conf.set("mail:dns:resolver", "something-else");
        expect(await build().resolveTxt("example.com")).toEqual([["from-node"]]);
    });

    it("reads its own configuration when the server has installed none (a process with no host)", async () => {
        uninstall?.();
        uninstall = undefined;
        const fetchMock = vi.fn().mockResolvedValue(dohAnswer("from-doh"));
        vi.stubGlobal("fetch", fetchMock);
        const resolver = build();
        (resolver as any).configuredMode = "doh-dnssec";
        expect(await resolver.resolveTxt("example.com")).toEqual([["from-doh"]]);
        // The DoH resolver's own configured endpoint applies, as it always did.
        expect(fetchMock.mock.calls[0][0]).toMatch(/^https:\/\/cloudflare-dns\.com\/dns-query\?/);
    });

    it("holds no answers of its own, so a switch has none to drop: every lookup goes to the resolver in force", async () => {
        const resolver = build();
        await resolver.resolveTxt("example.com");
        await resolver.resolveTxt("example.com");
        expect(node.resolveTxt).toHaveBeenCalledTimes(2);
    });
});

describe("DelegatingDnsResolver built by the ObjectFactory", () => {
    it("is injected as the DnsResolver with both resolvers behind it, and follows the integrations layer", async () => {
        const conf = layeredConfig({ mail: { dns: { resolver: "node" } } });
        const { cipher, factory } = await keyringCipher(conf);
        const layer = new IntegrationsLayer(conf, cipher, logger());
        const uninstall = HostConfig.install(conf);
        const resolveTxt = vi.spyOn(NodeDnsResolver.prototype, "resolveTxt").mockResolvedValue([["from-node"]]);
        const fetchMock = vi.fn().mockResolvedValue(dohAnswer("from-doh"));
        vi.stubGlobal("fetch", fetchMock);
        try {
            factory.register(DelegatingDnsResolver, "DnsResolver");
            const resolver: any = await factory.newInstance("DnsResolver", { name: "default" });
            expect(await resolver.resolveTxt("example.com")).toEqual([["from-node"]]);
            expect(resolveTxt).toHaveBeenCalledTimes(1);

            layer.apply(settingsRow(cipher, { version: 1, dnsResolver: { mode: "doh-dnssec", dohEndpoint: "https://doh.admin.example/dns-query" } }));
            expect(await resolver.resolveTxt("example.com")).toEqual([["from-doh"]]);
            expect(fetchMock.mock.calls[0][0]).toMatch(/^https:\/\/doh\.admin\.example\/dns-query\?/);
        } finally {
            uninstall();
            vi.restoreAllMocks();
            vi.unstubAllGlobals();
            await factory.destroy();
        }
    });
});
