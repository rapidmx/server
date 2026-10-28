///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
vi.mock("redis", async () => {
    const { createFakeRedisModule } = await import("../helpers/FakeRedis.js");
    return createFakeRedisModule();
});

import config from "../../src/config.mongo.js";
import fs from "fs";
import * as http from "http";
import { MongoMemoryServer } from "mongodb-memory-server";
import os from "os";
import path from "path";
import zlib from "zlib";
import { JWTUtils, Logger, sleep } from "@rapidrest/core";
import { ObjectFactory, Server } from "@rapidrest/service-core";
import {
    FsDkimKeyProvider,
    LocalFsBlobStore,
    LocalX509CertificateAuthority,
    ManualSigningCertificateEnrollment,
    NodeDnsResolver,
    PostfixSendmailTransport,
} from "@rapidmx/restapi";
import { MongoTextSearchProvider } from "@rapidmx/restapi/search";
import { ClamAvScanProvider, RspamdSpamScanProvider } from "@rapidmx/restapi/scan";
import { TieredRateLimiter } from "../../src/lib/TieredRateLimiter.js";
import { StaticAssetRoute as MongoStaticAssetRoute } from "../../src/mongo/routes/StaticAssetRoute.js";
import { STATIC_ASSET_PATHS } from "../../src/routes/BaseStaticAssetRoute.js";
import { StaticAssetRoute as SqlStaticAssetRoute } from "../../src/sql/routes/StaticAssetRoute.js";
import { freePort } from "../helpers/serverTestUtils.js";

/**
 * Every request that reached the rate limiter, and whether it was made by a signed-in user. Counts in memory: the fake
 * Redis of these tests has no INCREX, and the in-memory counters are what the limiter falls back to on an old Redis.
 */
class CountingRateLimiter extends TieredRateLimiter {
    public static calls: { identifier: string; signedIn: boolean }[] = [];

    public get cacheClient(): any {
        return undefined;
    }

    public async checkAndIncrement(identifier: string, cfg?: any, req?: any): Promise<void> {
        CountingRateLimiter.calls.push({ identifier, signedIn: !!req?.user?.uid });
        return super.checkAndIncrement(identifier, cfg, req);
    }
}

interface Reply {
    status: number;
    headers: http.IncomingHttpHeaders;
    body: Buffer;
}

/** A GET/HEAD to the test server that keeps the body's bytes (no decoding, like a browser's network layer would see). */
function request(port: number, method: string, urlPath: string, headers: Record<string, string> = {}): Promise<Reply> {
    return new Promise((resolve, reject) => {
        const req: http.ClientRequest = http.request({ host: "127.0.0.1", port, method, path: urlPath, headers, agent: false }, (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk: Buffer) => chunks.push(chunk));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
        });
        req.on("error", reject);
        req.end();
    });
}

/** A token for `uid` the way the auth-server signs them (the same `auth` config verifies it). */
function signToken(uid: string): string {
    return JWTUtils.createTokenSync(config.get("auth"), { uid, roles: ["user"], scopes: [] });
}

const mongod: MongoMemoryServer = new MongoMemoryServer({ instance: { dbName: "mongomemory-rrst-assets-test" } });

describe("StaticAssetRoute over a real HTTP server", () => {
    const logger = new Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    // Mirrors Server.mongo.test.ts's provider registration: this builds its own Server from the mongo routes.
    objectFactory.register(LocalFsBlobStore, "BlobStore");
    objectFactory.register(MongoTextSearchProvider, "SearchProvider");
    objectFactory.register(RspamdSpamScanProvider, "SpamScanProvider");
    objectFactory.register(ClamAvScanProvider, "AvScanProvider");
    objectFactory.register(PostfixSendmailTransport, "MailTransport");
    objectFactory.register(NodeDnsResolver, "DnsResolver");
    objectFactory.register(FsDkimKeyProvider, "DkimKeyProvider");
    objectFactory.register(LocalX509CertificateAuthority, "EncryptionCertificateAuthority");
    objectFactory.register(ManualSigningCertificateEnrollment, "SigningCertificateEnrollment");
    objectFactory.register(CountingRateLimiter, "RateLimiter");

    let server: Server;
    let port: number;
    let outDir: string;
    let bundle: Buffer;
    const bundleUrl = "/assets/client-2ASwhfpx.js";
    const previousManifest: unknown = config.get("react:manifestPath");

    beforeAll(async () => {
        await mongod.start();
        for (const name of ["acl", "mongo"]) {
            config.set(`datastores:${name}:url`, mongod.getUri());
        }
        // A stand-in for `dist/public`: Vite's assets/, the static folders copied from public/, and the manifest that locates them.
        outDir = fs.mkdtempSync(path.join(os.tmpdir(), "rapidmx-static-route-"));
        for (const dir of ["assets", "images", "fonts", "styles", ".vite"]) {
            fs.mkdirSync(path.join(outDir, dir));
        }
        bundle = Buffer.from("export const greeting = 'hello from a bundle';\n".repeat(4000));
        fs.writeFileSync(path.join(outDir, "assets", "client-2ASwhfpx.js"), bundle);
        fs.writeFileSync(path.join(outDir, "assets", "client-BGE0Mndc.css"), ".button { color: red; }\n".repeat(500));
        fs.writeFileSync(path.join(outDir, "assets", "wa-sqlite-async-zc68fxQq.wasm"), Buffer.alloc(300_000, 9));
        fs.writeFileSync(path.join(outDir, "images", "logo.svg"), '<svg xmlns="http://www.w3.org/2000/svg"></svg>\n'.repeat(500));
        fs.writeFileSync(path.join(outDir, "images", "logo.png"), Buffer.alloc(3000, 4));
        fs.writeFileSync(path.join(outDir, "fonts", "Blender-Pro-Book.ttf"), Buffer.alloc(60_000, 5));
        fs.writeFileSync(path.join(outDir, "favicon.ico"), Buffer.alloc(14_000, 2));
        fs.writeFileSync(path.join(outDir, "styles", "globals.css"), "body { margin: 0; }\n".repeat(300));
        fs.writeFileSync(path.join(outDir, ".vite", "manifest.json"), "{}");
        config.set("react:manifestPath", path.join(outDir, ".vite", "manifest.json"));

        port = await freePort();
        config.set("port", port);
        config.set("listen_host", "127.0.0.1");
        server = new Server({ config, basePath: "./src/mongo", logger, objectFactory });
        await server.start();
        await sleep(1000);
    }, 120_000);

    afterAll(async () => {
        await server?.stop();
        await mongod.stop();
        config.set("react:manifestPath", previousManifest);
        // ReactRoute watches its manifest in a non-production run, and on Windows removing a watched folder raises EPERM
        // in the watcher: remove the fixture as this test process exits instead.
        process.once("exit", () => fs.rmSync(outDir, { recursive: true, force: true }));
    });

    beforeEach(() => {
        CountingRateLimiter.calls = [];
    });

    it("mounts the same static folders for both datastores", () => {
        expect(Reflect.getMetadata("rrst:routePaths", MongoStaticAssetRoute.prototype)).toEqual(STATIC_ASSET_PATHS);
        expect(Reflect.getMetadata("rrst:routePaths", SqlStaticAssetRoute.prototype)).toEqual(STATIC_ASSET_PATHS);
        expect(STATIC_ASSET_PATHS).toEqual(["/assets", "/fonts", "/images", "/styles", "/favicon.ico"]);
    });

    it("sends a fingerprinted bundle brotli-compressed, cacheable forever, with a validator", async () => {
        const res = await request(port, "GET", bundleUrl, { "Accept-Encoding": "gzip, br" });
        expect(res.status).toBe(200);
        expect(res.headers["content-encoding"]).toBe("br");
        expect(res.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
        expect(res.headers["content-type"]).toBe("text/javascript; charset=utf-8");
        expect(res.headers["vary"]).toContain("Accept-Encoding");
        expect(res.headers["etag"]).toMatch(/^W\/"/);
        expect(res.headers["x-content-type-options"]).toBe("nosniff");
        expect(Number(res.headers["content-length"])).toBe(res.body.length);
        expect(zlib.brotliDecompressSync(res.body).equals(bundle)).toBe(true);
        expect(res.body.length).toBeLessThan(bundle.length / 20);
    });

    it("falls back to gzip and to the plain bytes", async () => {
        const gz = await request(port, "GET", bundleUrl, { "Accept-Encoding": "gzip" });
        expect(gz.headers["content-encoding"]).toBe("gzip");
        expect(zlib.gunzipSync(gz.body).equals(bundle)).toBe(true);
        const plain = await request(port, "GET", bundleUrl);
        expect(plain.headers["content-encoding"]).toBeUndefined();
        expect(plain.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
        expect(plain.body.equals(bundle)).toBe(true);
    });

    it("answers a revalidation with 304 and no body", async () => {
        const first = await request(port, "GET", bundleUrl, { "Accept-Encoding": "br" });
        const second = await request(port, "GET", bundleUrl, { "Accept-Encoding": "br", "If-None-Match": String(first.headers["etag"]) });
        expect(second.status).toBe(304);
        expect(second.body.length).toBe(0);
        expect(second.headers["etag"]).toBe(first.headers["etag"]);
        expect(second.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
        expect(second.headers["content-length"] ?? "0").toBe("0");
    });

    it("answers HEAD with the headers and the length of the body a GET would send", async () => {
        const get = await request(port, "GET", bundleUrl, { "Accept-Encoding": "br" });
        const head = await request(port, "HEAD", bundleUrl, { "Accept-Encoding": "br" });
        expect(head.status).toBe(200);
        expect(head.body.length).toBe(0);
        expect(head.headers["content-length"]).toBe(String(get.body.length));
        expect(head.headers["content-encoding"]).toBe("br");
        expect(head.headers["etag"]).toBe(get.headers["etag"]);
        // A missing asset's HEAD has a real length too (uWS reports 2^63 when none is given).
        const missing = await request(port, "HEAD", "/assets/gone-abcdefgh.js");
        expect(missing.status).toBe(404);
        expect(missing.headers["content-length"]).toBe("9");
    });

    it("serves WebAssembly (which the pages' own file serving does not), compressed", async () => {
        const res = await request(port, "GET", "/assets/wa-sqlite-async-zc68fxQq.wasm", { "Accept-Encoding": "gzip, br" });
        expect(res.status).toBe(200);
        expect(res.headers["content-type"]).toBe("application/wasm");
        expect(res.headers["content-encoding"]).toBe("br");
        expect(res.body.length).toBeLessThan(2000);
    });

    it("serves the public folders: images compressed when they can be, revalidated outside production, fonts included", async () => {
        const svg = await request(port, "GET", "/images/logo.svg", { "Accept-Encoding": "br" });
        expect(svg.headers["content-type"]).toBe("image/svg+xml");
        expect(svg.headers["content-encoding"]).toBe("br");
        const png = await request(port, "GET", "/images/logo.png", { "Accept-Encoding": "br" });
        expect(png.headers["content-type"]).toBe("image/png");
        expect(png.headers["content-encoding"]).toBeUndefined();
        expect(png.body.length).toBe(3000);
        const font = await request(port, "GET", "/fonts/Blender-Pro-Book.ttf", { "Accept-Encoding": "br" });
        expect(font.headers["content-type"]).toBe("font/ttf");
        expect(font.headers["content-encoding"]).toBe("br");
        const css = await request(port, "GET", "/styles/globals.css", { "Accept-Encoding": "gzip" });
        expect(css.headers["content-type"]).toBe("text/css; charset=utf-8");
        expect(css.headers["cache-control"]).toBe("no-cache");
        expect(css.headers["etag"]).toBeDefined();
    });

    it("serves /favicon.ico compressed, and answers a bare folder path with a plain 404", async () => {
        const icon = await request(port, "GET", "/favicon.ico", { "Accept-Encoding": "br" });
        expect(icon.status).toBe(200);
        expect(icon.headers["content-type"]).toBe("image/x-icon");
        expect(icon.headers["content-encoding"]).toBe("br");
        const head = await request(port, "HEAD", "/favicon.ico", { "Accept-Encoding": "br" });
        expect(head.headers["content-length"]).toBe(String(icon.body.length));
        for (const folder of ["/assets", "/images"]) {
            const res = await request(port, "GET", folder);
            expect(res.status).toBe(404);
            expect(res.headers["content-type"]).toBe("text/plain; charset=utf-8");
        }
    });

    it("answers a missing file with a plain 404 that is never cached, and hides dot folders and other build files", async () => {
        for (const url of ["/assets/gone-abcdefgh.js", "/assets/", "/images/../.vite/manifest.json", "/assets/%2e%2e/.vite/manifest.json", "/images/.vite"]) {
            const res = await request(port, "GET", url);
            expect(res.status, url).toBe(404);
            expect(res.headers["content-type"]).toBe("text/plain; charset=utf-8");
            expect(res.headers["cache-control"]).toBe("no-store");
        }
    });

    it("leaves every other path to the pages' own route", async () => {
        // A page that doesn't exist is the pages' route's: never this route's plain text. (A test run can't import the web
        // client's .tsx pages, so it answers with its error response, not the rendered 404 page.)
        const res = await request(port, "GET", "/no-such-page", { Accept: "text/html" });
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(res.headers["content-type"]).not.toContain("text/plain");
        expect(res.headers["x-content-type-options"]).toBeUndefined();
        // And a POST to an asset is not this route's.
        const post = await new Promise<number>((resolve, reject) => {
            const req = http.request({ host: "127.0.0.1", port, method: "POST", path: bundleUrl }, (r) => {
                r.resume();
                r.on("end", () => resolve(r.statusCode ?? 0));
            });
            req.on("error", reject);
            req.end();
        });
        expect(post).toBe(404);
    });

    describe("rate limiting", () => {
        it("does not count a cold page load: ~25 static files and ~15 API calls in one burst reach no limiter and get no 429", async () => {
            const urls: string[] = [
                ...Array.from({ length: 12 }, () => bundleUrl),
                ...Array.from({ length: 5 }, () => "/assets/client-BGE0Mndc.css"),
                "/assets/wa-sqlite-async-zc68fxQq.wasm",
                "/images/logo.svg",
                "/images/logo.svg",
                "/images/logo.png",
                "/fonts/Blender-Pro-Book.ttf",
                "/styles/globals.css",
                "/no-such-page",
                "/no-such-page",
                ...Array.from({ length: 5 }, () => "/api/status"),
                ...Array.from({ length: 5 }, () => "/api/system/branding"),
                ...Array.from({ length: 5 }, () => "/api/mail/folders"),
            ];
            expect(urls.length).toBe(40);
            const replies: Reply[] = await Promise.all(urls.map((url) => request(port, "GET", url, { "Accept-Encoding": "gzip, br" })));
            expect(replies.filter((reply) => reply.status === 429)).toHaveLength(0);
            // (The two page requests fail to render in a test run, see above; everything else answers normally.)
            expect(replies.filter((reply, i) => reply.status >= 500 && !urls[i].startsWith("/no-such-page"))).toHaveLength(0);
            expect(CountingRateLimiter.calls).toHaveLength(0);
        });

        it("keeps a signed-in mail session far from the limits: 1,000 rate-limited calls in a burst are all counted for the user and none is refused", async () => {
            const token: string = signToken("alice");
            const replies: Reply[] = [];
            for (let batch = 0; batch < 10; batch++) {
                replies.push(
                    ...(await Promise.all(
                        Array.from({ length: 100 }, () => request(port, "GET", "/api/mail/mailboxes/some-mailbox/keys/lookup?addr=bob%40example.com", { Authorization: `Bearer ${token}` })),
                    )),
                );
            }
            expect(replies.filter((reply) => reply.status === 429)).toHaveLength(0);
            // Not 401: the token was accepted, so the request was made as a user and got the signed-in tier.
            expect(replies.every((reply) => reply.status !== 401)).toBe(true);
            expect(CountingRateLimiter.calls).toHaveLength(1000);
            expect(CountingRateLimiter.calls.every((call) => call.signedIn && call.identifier.startsWith("alice|GET|"))).toBe(true);
        });

        it("still stops an anonymous caller of a public endpoint: 100 requests per minute per address and endpoint", async () => {
            const url = "/.well-known/rapidmx/keys/0123456789abcdef";
            const statuses: number[] = [];
            for (let i = 0; i < 101; i++) {
                statuses.push((await request(port, "GET", url)).status);
            }
            expect(statuses.slice(0, 100).filter((status) => status === 429)).toHaveLength(0);
            expect(statuses[100]).toBe(429);
            expect(CountingRateLimiter.calls.every((call) => !call.signedIn && call.identifier.includes("127.0.0.1"))).toBe(true);
        });
    });
});
