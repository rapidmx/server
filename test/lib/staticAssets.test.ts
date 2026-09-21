///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import fs from "fs";
import os from "os";
import path from "path";
import zlib from "zlib";
import {
    assetMimeType,
    compressBuffer,
    etagMatches,
    IMMUTABLE_CACHE_CONTROL,
    isCompressible,
    isFingerprintedAsset,
    preferredEncoding,
    precompressDirectory,
    REVALIDATE_CACHE_CONTROL,
    StaticAssetServer,
    STATIC_CACHE_CONTROL,
} from "../../src/lib/staticAssets.js";

/** A compressible payload of about `bytes` bytes. */
function text(bytes: number): string {
    return "export const value = 'the quick brown fox jumps over the lazy dog';\n".repeat(Math.ceil(bytes / 64));
}

describe("staticAssets helpers", () => {
    it("knows the content types of a build, including WebAssembly, with a charset on text", () => {
        expect(assetMimeType("assets/wa-sqlite-async-zc68fxQq.wasm")).toBe("application/wasm");
        expect(assetMimeType("assets/client-2ASwhfpx.js")).toBe("text/javascript; charset=utf-8");
        expect(assetMimeType("assets/client-BGE0Mndc.css")).toBe("text/css; charset=utf-8");
        expect(assetMimeType("images/logo.SVG")).toBe("image/svg+xml");
        expect(assetMimeType("fonts/a.woff2")).toBe("font/woff2");
        expect(assetMimeType("something.unknown")).toBe("application/octet-stream");
    });

    it("compresses text, WebAssembly, TrueType fonts and icons, but not files that are compressed already", () => {
        for (const file of ["a.js", "a.css", "a.json", "a.svg", "a.wasm", "a.ttf", "favicon.ico", "a.html"]) {
            expect(isCompressible(file)).toBe(true);
        }
        for (const file of ["a.png", "a.jpg", "a.webp", "a.avif", "a.woff", "a.woff2", "a.gif", "a.br"]) {
            expect(isCompressible(file)).toBe(false);
        }
    });

    it("recognizes fingerprinted bundles under assets/ only", () => {
        for (const name of [
            "assets/client-2ASwhfpx.js",
            "assets/client-BGE0Mndc.css",
            "assets/signatureDefaults---VbZvtX.js",
            "assets/domainsApi-CtFM8Fy-.js",
            "assets/wa-sqlite-async-zc68fxQq.wasm",
            "assets/node_modules/@rapidmx/web-client/apps/www/index.tsx-z4CL5-1H.js",
            "assets/node_modules/@rapidmx/web-client/apps/admin/domains/_uid_.tsx--sjabo9k.js",
        ]) {
            expect(isFingerprintedAsset(name)).toBe(true);
        }
        for (const name of ["assets/plain.js", "assets/short-abc.js", "fonts/Blender-Pro-Bold.ttf", "images/logo.svg", "favicon.ico", "assets", ""]) {
            expect(isFingerprintedAsset(name)).toBe(false);
        }
    });

    it("chooses brotli over gzip, and honors q values and the wildcard", () => {
        expect(preferredEncoding(undefined)).toBeUndefined();
        expect(preferredEncoding("")).toBeUndefined();
        expect(preferredEncoding("gzip, deflate, br")).toBe("br");
        expect(preferredEncoding("gzip, br;q=0")).toBe("gzip");
        expect(preferredEncoding("gzip;q=1.0, br;q=0.5")).toBe("gzip");
        expect(preferredEncoding("gzip")).toBe("gzip");
        expect(preferredEncoding("x-gzip")).toBe("gzip");
        expect(preferredEncoding(["deflate", "br"])).toBe("br");
        expect(preferredEncoding("deflate")).toBeUndefined();
        expect(preferredEncoding("identity")).toBeUndefined();
        expect(preferredEncoding("*")).toBe("br");
        expect(preferredEncoding("*;q=0, gzip")).toBe("gzip");
        expect(preferredEncoding("br;q=0, gzip;q=0")).toBeUndefined();
        expect(preferredEncoding("br;q=oops")).toBe("br");
        expect(preferredEncoding(", ,br")).toBe("br");
    });

    it("compares If-None-Match weakly, with lists and *", () => {
        expect(etagMatches(undefined, '"a"')).toBe(false);
        expect(etagMatches("", '"a"')).toBe(false);
        expect(etagMatches('"a"', '"a"')).toBe(true);
        expect(etagMatches('W/"a"', '"a"')).toBe(true);
        expect(etagMatches('"a"', 'W/"a"')).toBe(true);
        expect(etagMatches('"b", "a"', '"a"')).toBe(true);
        expect(etagMatches(['"b"', 'W/"a"'], '"a"')).toBe(true);
        expect(etagMatches('"b"', '"a"')).toBe(false);
        expect(etagMatches("*", '"a"')).toBe(true);
    });

    it("round-trips both encodings", async () => {
        const data: Buffer = Buffer.from(text(5000));
        expect(zlib.brotliDecompressSync(await compressBuffer(data, "br")).equals(data)).toBe(true);
        expect(zlib.brotliDecompressSync(await compressBuffer(data, "br", 5)).equals(data)).toBe(true);
        expect(zlib.gunzipSync(await compressBuffer(data, "gzip")).equals(data)).toBe(true);
    });
});

describe("precompressDirectory", () => {
    let dir: string;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "rapidmx-precompress-"));
        fs.mkdirSync(path.join(dir, "assets"));
        fs.mkdirSync(path.join(dir, ".vite"));
        fs.writeFileSync(path.join(dir, "assets", "app-abcdefgh.js"), text(20_000));
        fs.writeFileSync(path.join(dir, "assets", "tiny-abcdefgh.js"), "x");
        fs.writeFileSync(path.join(dir, "assets", "photo.png"), Buffer.alloc(5000, 7));
        fs.writeFileSync(path.join(dir, ".vite", "manifest.json"), text(3000));
        fs.writeFileSync(path.join(dir, "random.bin.json"), zlib.brotliCompressSync(Buffer.from(text(3000))));
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it("writes .br and .gz siblings for compressible files that shrink and leaves the rest alone", async () => {
        const result = await precompressDirectory(dir, { brotliQuality: 5 });
        const js: Buffer = fs.readFileSync(path.join(dir, "assets", "app-abcdefgh.js"));
        expect(zlib.brotliDecompressSync(fs.readFileSync(path.join(dir, "assets", "app-abcdefgh.js.br"))).equals(js)).toBe(true);
        expect(zlib.gunzipSync(fs.readFileSync(path.join(dir, "assets", "app-abcdefgh.js.gz"))).equals(js)).toBe(true);
        expect(fs.existsSync(path.join(dir, "assets", "tiny-abcdefgh.js.br"))).toBe(false);
        expect(fs.existsSync(path.join(dir, "assets", "photo.png.br"))).toBe(false);
        expect(fs.existsSync(path.join(dir, ".vite", "manifest.json.br"))).toBe(false);
        expect(fs.existsSync(path.join(dir, "random.bin.json.br"))).toBe(false);
        expect(result.compressed).toBe(1);
        expect(result.skipped).toBe(2);
        expect(result.bytesBefore).toBe(js.length);
        expect(result.bytesAfter).toBeLessThan(js.length / 10);
    });

    it("keeps up-to-date siblings, refreshes stale ones and can skip gzip", async () => {
        await precompressDirectory(dir, { brotliQuality: 5, gzip: false });
        const br: string = path.join(dir, "assets", "app-abcdefgh.js.br");
        expect(fs.existsSync(br + ".gz") || fs.existsSync(path.join(dir, "assets", "app-abcdefgh.js.gz"))).toBe(false);

        const before: number = fs.statSync(br).mtimeMs;
        expect((await precompressDirectory(dir, { brotliQuality: 5, gzip: false })).compressed).toBe(0);
        expect(fs.statSync(br).mtimeMs).toBe(before);

        // The source changed after its sibling was written.
        const source: string = path.join(dir, "assets", "app-abcdefgh.js");
        fs.writeFileSync(source, text(30_000));
        const later: Date = new Date(Date.now() + 5000);
        fs.utimesSync(source, later, later);
        expect((await precompressDirectory(dir, { brotliQuality: 5, gzip: false })).compressed).toBe(1);
        expect(zlib.brotliDecompressSync(fs.readFileSync(br)).length).toBe(fs.statSync(source).size);
    });
});

describe("StaticAssetServer", () => {
    let root: string;
    let asset: string;
    let source: Buffer;
    const accept = (encoding: string, extra: Record<string, string> = {}) => ({ "accept-encoding": encoding, ...extra });

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), "rapidmx-assets-"));
        fs.mkdirSync(path.join(root, "assets"));
        fs.mkdirSync(path.join(root, "images"));
        fs.mkdirSync(path.join(root, ".vite"));
        source = Buffer.from(text(30_000));
        asset = "/assets/client-2ASwhfpx.js";
        fs.writeFileSync(path.join(root, "assets", "client-2ASwhfpx.js"), source);
        fs.writeFileSync(path.join(root, "assets", "wa-sqlite-zc68fxQq.wasm"), Buffer.alloc(50_000, 1));
        fs.writeFileSync(path.join(root, "assets", "small-abcdefgh.js"), "export {};");
        fs.writeFileSync(path.join(root, "images", "logo.png"), Buffer.alloc(4000, 3));
        fs.writeFileSync(path.join(root, "images", "logo.svg"), text(3000));
        fs.writeFileSync(path.join(root, "styles.css"), text(3000));
        fs.writeFileSync(path.join(root, ".vite", "manifest.json"), "{}");
        fs.writeFileSync(path.join(root, "images", "with space.png"), Buffer.alloc(100));
    });

    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    it("serves a fingerprinted bundle brotli-compressed, immutable and with a validator", async () => {
        const server = new StaticAssetServer({ production: true });
        const res = await server.respond(root, asset, accept("gzip, br"));
        expect(res.status).toBe(200);
        expect(res.headers["content-encoding"]).toBe("br");
        expect(res.headers["cache-control"]).toBe(IMMUTABLE_CACHE_CONTROL);
        expect(res.headers["content-type"]).toBe("text/javascript; charset=utf-8");
        expect(res.headers["vary"]).toBe("Accept-Encoding");
        expect(res.headers["x-content-type-options"]).toBe("nosniff");
        expect(res.headers["etag"]).toMatch(/^W\/"[0-9a-f]+-[0-9a-f]+-br"$/);
        expect(zlib.brotliDecompressSync(res.body!).equals(source)).toBe(true);
        expect(res.contentLength).toBe(res.body!.length);
        expect(res.body!.length).toBeLessThan(source.length / 20);
    });

    it("falls back to gzip, then to the bytes as they are, with a different ETag for each", async () => {
        const server = new StaticAssetServer({ production: true });
        const gz = await server.respond(root, asset, accept("gzip"));
        expect(gz.headers["content-encoding"]).toBe("gzip");
        expect(zlib.gunzipSync(gz.body!).equals(source)).toBe(true);
        const plain = await server.respond(root, asset, {});
        expect(plain.headers["content-encoding"]).toBeUndefined();
        expect(plain.headers["vary"]).toBe("Accept-Encoding");
        expect(plain.body!.equals(source)).toBe(true);
        expect(plain.headers["etag"]).toMatch(/^"[0-9a-f]+-[0-9a-f]+"$/);
        expect(new Set([gz.headers["etag"], plain.headers["etag"], (await server.respond(root, asset, accept("br"))).headers["etag"]]).size).toBe(3);
    });

    it("answers a matching If-None-Match with 304 and no body, per encoding", async () => {
        const server = new StaticAssetServer({ production: true });
        const first = await server.respond(root, asset, accept("br"));
        const revalidated = await server.respond(root, asset, accept("br", { "if-none-match": first.headers["etag"] }));
        expect(revalidated.status).toBe(304);
        expect(revalidated.body).toBeUndefined();
        expect(revalidated.headers["etag"]).toBe(first.headers["etag"]);
        expect(revalidated.headers["cache-control"]).toBe(IMMUTABLE_CACHE_CONTROL);
        // The gzip variant's validator is not the brotli one.
        const other = await server.respond(root, asset, accept("gzip", { "if-none-match": first.headers["etag"] }));
        expect(other.status).toBe(200);
    });

    it("uses the pre-compressed sibling from the build when it is fresh, and compresses on demand otherwise", async () => {
        const server = new StaticAssetServer({ production: true });
        const marker: Buffer = zlib.brotliCompressSync(Buffer.from("not the real bytes"), {});
        // A sibling that isn't smaller than its source isn't worth sending: the file goes out as it is ...
        fs.writeFileSync(path.join(root, "assets", "client-2ASwhfpx.js.br"), Buffer.alloc(source.length + 10));
        let res = await server.respond(root, asset, accept("br"));
        expect(res.headers["content-encoding"]).toBeUndefined();
        expect(res.body!.equals(source)).toBe(true);
        server.clear();
        // ... a stale one (older than its source) as well ...
        fs.writeFileSync(path.join(root, "assets", "client-2ASwhfpx.js.br"), marker);
        const old: Date = new Date(Date.now() - 60_000);
        fs.utimesSync(path.join(root, "assets", "client-2ASwhfpx.js.br"), old, old);
        res = await server.respond(root, asset, accept("br"));
        expect(zlib.brotliDecompressSync(res.body!).equals(source)).toBe(true);
        server.clear();
        // ... and a fresh one is sent as it is.
        const future: Date = new Date(Date.now() + 60_000);
        fs.utimesSync(path.join(root, "assets", "client-2ASwhfpx.js.br"), future, future);
        res = await server.respond(root, asset, accept("br"));
        expect(res.body!.equals(marker)).toBe(true);
        // Outside production the siblings aren't trusted: a rebuilt file could be behind a stale one.
        const dev = new StaticAssetServer({ production: false });
        res = await dev.respond(root, asset, accept("br"));
        expect(zlib.brotliDecompressSync(res.body!).equals(source)).toBe(true);
    });

    it("serves WebAssembly compressed with the right type", async () => {
        const res = await new StaticAssetServer({ production: true }).respond(root, "/assets/wa-sqlite-zc68fxQq.wasm", accept("br"));
        expect(res.headers["content-type"]).toBe("application/wasm");
        expect(res.headers["content-encoding"]).toBe("br");
        expect(res.headers["cache-control"]).toBe(IMMUTABLE_CACHE_CONTROL);
    });

    it("leaves images, tiny files and incompressible bytes alone, and only varies where it may compress", async () => {
        const server = new StaticAssetServer({ production: true });
        const png = await server.respond(root, "/images/logo.png", accept("gzip, br"));
        expect(png.headers["content-encoding"]).toBeUndefined();
        expect(png.headers["vary"]).toBeUndefined();
        expect(png.headers["content-type"]).toBe("image/png");
        expect(png.body!.length).toBe(4000);
        const small = await server.respond(root, "/assets/small-abcdefgh.js", accept("br"));
        expect(small.headers["content-encoding"]).toBeUndefined();
        expect(small.body!.toString()).toBe("export {};");
        // A file that gets no smaller is sent as it is, and remembered as such.
        fs.writeFileSync(path.join(root, "images", "noise.svg"), zlib.brotliCompressSync(Buffer.from(text(3000))));
        const noise = await server.respond(root, "/images/noise.svg", accept("br"));
        expect(noise.headers["content-encoding"]).toBeUndefined();
        expect(noise.headers["etag"]).toMatch(/^"/);
        expect((await server.respond(root, "/images/noise.svg", accept("br"))).body!.equals(noise.body!)).toBe(true);
    });

    it("does not compress at all with compress off", async () => {
        const res = await new StaticAssetServer({ compress: false }).respond(root, asset, accept("br"));
        expect(res.headers["content-encoding"]).toBeUndefined();
        expect(res.headers["vary"]).toBeUndefined();
        expect(res.body!.equals(source)).toBe(true);
    });

    it("caches un-fingerprinted images for an hour and code for revalidation in production; everything revalidates in dev", async () => {
        const prod = new StaticAssetServer({ production: true });
        expect((await prod.respond(root, "/images/logo.png", {})).headers["cache-control"]).toBe(STATIC_CACHE_CONTROL);
        expect((await prod.respond(root, "/images/logo.svg", {})).headers["cache-control"]).toBe(STATIC_CACHE_CONTROL);
        expect((await prod.respond(root, "/styles.css", {})).headers["cache-control"]).toBe(REVALIDATE_CACHE_CONTROL);
        const dev = new StaticAssetServer({ production: false });
        expect((await dev.respond(root, "/images/logo.png", {})).headers["cache-control"]).toBe(REVALIDATE_CACHE_CONTROL);
        expect((await dev.respond(root, asset, {})).headers["cache-control"]).toBe(IMMUTABLE_CACHE_CONTROL);
    });

    it("answers 404 without caching for a missing file, a folder and paths that leave the build folder", async () => {
        const server = new StaticAssetServer({ production: true });
        for (const url of [
            "/assets/missing-abcdefgh.js",
            "/assets",
            "/",
            "",
            "/assets/../../etc/passwd",
            "/assets/%2e%2e/%2e%2e/etc/passwd",
            "/.vite/manifest.json",
            "/assets/.hidden",
            "/assets/a\\b.js",
            "/assets/%00.js",
            "/assets/C:/Windows/win.ini",
        ]) {
            const res = await server.respond(root, url, {});
            expect(res.status, url).toBe(404);
            expect(res.headers["cache-control"]).toBe("no-store");
            expect(res.headers["content-type"]).toBe("text/plain; charset=utf-8");
            expect(res.body!.toString()).toBe("Not Found");
        }
        const malformed = await server.respond(root, "/assets/%E0%A4%A", {});
        expect(malformed.status).toBe(400);
    });

    it("decodes percent-encoded names", async () => {
        const res = await new StaticAssetServer({ production: true }).respond(root, "/images/with%20space.png", {});
        expect(res.status).toBe(200);
        expect(res.body!.length).toBe(100);
    });

    it("picks up a changed file and evicts the least recently used one beyond its memory limit", async () => {
        const server = new StaticAssetServer({ production: true, maxCacheBytes: 40_000 });
        const before = await server.respond(root, "/images/logo.svg", {});
        expect(server.cacheSize).toBeGreaterThan(0);
        fs.writeFileSync(path.join(root, "images", "logo.svg"), text(4000));
        const later: Date = new Date(Date.now() + 5000);
        fs.utimesSync(path.join(root, "images", "logo.svg"), later, later);
        const after = await server.respond(root, "/images/logo.svg", {});
        expect(after.body!.length).toBe(text(4000).length);
        expect(after.headers["etag"]).not.toBe(before.headers["etag"]);

        await server.respond(root, asset, {});
        await server.respond(root, "/assets/wa-sqlite-zc68fxQq.wasm", {});
        expect(server.cacheSize).toBeLessThanOrEqual(40_000 + 50_000);
        server.clear();
        expect(server.cacheSize).toBe(0);
    });

    it("compresses a file once for concurrent requests", async () => {
        const server = new StaticAssetServer({ production: false });
        const results = await Promise.all(Array.from({ length: 10 }, () => server.respond(root, asset, accept("br"))));
        for (const res of results) {
            expect(res.body).toBe(results[0].body);
        }
    });

    it("reports a file that disappears mid-request as 404", async () => {
        const server = new StaticAssetServer({ production: true });
        const spy = vi.spyOn(fs.promises, "readFile").mockRejectedValueOnce(Object.assign(new Error("gone"), { code: "ENOENT" }));
        try {
            expect((await server.respond(root, "/images/logo.png", {})).status).toBe(404);
        } finally {
            spy.mockRestore();
        }
        expect((await server.respond(root, "/images/logo.png", {})).status).toBe(200);
    });
});
