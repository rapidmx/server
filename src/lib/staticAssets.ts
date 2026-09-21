///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import fs from "fs";
import path from "path";
import { promisify } from "util";
import zlib from "zlib";

const brotliCompress = promisify(zlib.brotliCompress);
const gzipCompress = promisify(zlib.gzip);

/** The content encodings a static asset can be served with. */
export type AssetEncoding = "br" | "gzip";

/** File extension of the pre-compressed sibling written for each encoding (`app.js` -> `app.js.br`). */
const ENCODING_EXTENSIONS: Record<AssetEncoding, string> = { br: ".br", gzip: ".gz" };

/** Content types of the files the browser bundles and `public/` folder contain. Text types carry their charset. */
export const ASSET_MIME_TYPES: Readonly<Record<string, string>> = {
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".cjs": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".map": "application/json; charset=utf-8",
    ".webmanifest": "application/manifest+json; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".xml": "application/xml; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".jfif": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".avif": "image/avif",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
    ".eot": "application/vnd.ms-fontobject",
    ".wasm": "application/wasm",
};

/** The content type of `file` (by extension), `application/octet-stream` when it isn't a known one. */
export function assetMimeType(file: string): string {
    return ASSET_MIME_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

/**
 * The extensions worth compressing: text, and the binary formats that aren't compressed already (WebAssembly, TrueType
 * fonts and icons shrink a lot; PNG/JPEG/WebP/AVIF/WOFF/WOFF2 don't, so compressing them only costs CPU).
 */
export const COMPRESSIBLE_EXTENSIONS: ReadonlySet<string> = new Set([
    ".css", ".js", ".mjs", ".cjs", ".json", ".map", ".webmanifest", ".html", ".htm", ".txt", ".xml", ".svg", ".wasm",
    ".ttf", ".otf", ".eot", ".ico",
]);

/** Files smaller than this are sent as they are: the HTTP headers outweigh any saving. */
export const MIN_COMPRESS_BYTES = 1024;

export function isCompressible(file: string): boolean {
    return COMPRESSIBLE_EXTENSIONS.has(path.extname(file).toLowerCase());
}

/**
 * Whether `relativePath` (relative to the build's output folder, forward slashes) is a fingerprinted bundle: a file
 * under `assets/` whose name ends in the 8-character content hash Vite writes before the extension
 * (`client-2ASwhfpx.js`, `index.tsx-z4CL5-1H.js`, `wa-sqlite-async-zc68fxQq.wasm`). Its URL changes whenever its bytes
 * do, so it can be cached forever. Only `assets/` is checked - Vite writes nothing else there - because a name like
 * `Blender-Pro-Bold.ttf` also looks hashed.
 */
export function isFingerprintedAsset(relativePath: string): boolean {
    const segments: string[] = relativePath.split("/").filter((segment) => segment.length > 0);
    return segments.length >= 2 && segments[0] === "assets" && /-[A-Za-z0-9_-]{8}\.[A-Za-z0-9]+$/.test(segments[segments.length - 1]);
}

/**
 * The encoding to answer with for an `Accept-Encoding` header: brotli when the client accepts it (at least as
 * strongly as gzip), else gzip, else none. Honors `q` values (`br;q=0` refuses brotli) and the `*` wildcard.
 */
export function preferredEncoding(header: string | string[] | undefined): AssetEncoding | undefined {
    const text: string = Array.isArray(header) ? header.join(",") : (header ?? "");
    if (!text) {
        return undefined;
    }
    const weights: Map<string, number> = new Map();
    for (const part of text.toLowerCase().split(",")) {
        const [name, ...params] = part.trim().split(";");
        if (!name) {
            continue;
        }
        let weight: number = 1;
        for (const param of params) {
            const match: RegExpExecArray | null = /^\s*q\s*=\s*([0-9.]+)\s*$/.exec(param);
            if (match && Number.isFinite(parseFloat(match[1]))) {
                weight = parseFloat(match[1]);
            }
        }
        weights.set(name.trim(), weight);
    }
    const weightOf = (...names: string[]): number => Math.max(...names.map((name) => weights.get(name) ?? weights.get("*") ?? 0));
    const br: number = weightOf("br");
    const gzip: number = weightOf("gzip", "x-gzip");
    if (br > 0 && br >= gzip) {
        return "br";
    }
    if (gzip > 0) {
        return "gzip";
    }
    return undefined;
}

/** Whether an `If-None-Match` header matches `etag` (weak comparison, as RFC 9110 requires for GET/HEAD). */
export function etagMatches(ifNoneMatch: string | string[] | undefined, etag: string): boolean {
    const text: string = Array.isArray(ifNoneMatch) ? ifNoneMatch.join(",") : (ifNoneMatch ?? "");
    if (!text) {
        return false;
    }
    if (text.trim() === "*") {
        return true;
    }
    const strip = (tag: string): string => tag.trim().replace(/^W\//i, "");
    const wanted: string = strip(etag);
    return (text.match(/(?:W\/)?"[^"]*"/gi) ?? []).some((tag) => strip(tag) === wanted);
}

/** Compresses `data` with `encoding`. `brotliQuality` 11 is the best ratio (slow, for build time), 9 the runtime default. */
export async function compressBuffer(data: Buffer, encoding: AssetEncoding, brotliQuality: number = 9): Promise<Buffer> {
    if (encoding === "br") {
        return await brotliCompress(data, {
            params: { [zlib.constants.BROTLI_PARAM_QUALITY]: brotliQuality, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: data.length },
        });
    }
    return await gzipCompress(data, { level: 9 });
}

export interface PrecompressOptions {
    /** Brotli quality, 0-11. Default 11: the build runs once, the browser downloads it many times. */
    brotliQuality?: number;
    /** Also write `.gz` siblings for clients that don't accept brotli. Default true. */
    gzip?: boolean;
    /** Files smaller than this are left alone. Default `MIN_COMPRESS_BYTES`. */
    minBytes?: number;
    /** How many files are compressed at once. Default 4 (the thread pool's size). */
    concurrency?: number;
}

export interface PrecompressResult {
    /** Source files that got at least one compressed sibling written. */
    compressed: number;
    /** Source files already up to date, too small, not compressible, or that don't shrink. */
    skipped: number;
    /** Total size of the compressed sources, and of their brotli (or gzip) siblings. */
    bytesBefore: number;
    bytesAfter: number;
}

/** The compressible files under `dir` (recursively, ignoring dot folders such as `.vite`, and siblings this module wrote). */
async function listFiles(dir: string): Promise<string[]> {
    const found: string[] = [];
    for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
        if (entry.name.startsWith(".")) {
            continue;
        }
        const full: string = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            found.push(...(await listFiles(full)));
        } else if (entry.isFile() && !/\.(br|gz)$/i.test(entry.name)) {
            found.push(full);
        }
    }
    return found;
}

/**
 * Writes a `.br` and a `.gz` sibling next to every compressible file under `dir` (`app.js` -> `app.js.br`, `app.js.gz`),
 * the pre-compressed variants `StaticAssetServer` sends with `Content-Encoding` instead of compressing per request. A
 * sibling is only written when it is smaller than its source, and an up-to-date one (not older than its source) is kept,
 * so running this again is cheap.
 */
export async function precompressDirectory(dir: string, options: PrecompressOptions = {}): Promise<PrecompressResult> {
    const { brotliQuality = 11, gzip = true, minBytes = MIN_COMPRESS_BYTES, concurrency = 4 } = options;
    const result: PrecompressResult = { compressed: 0, skipped: 0, bytesBefore: 0, bytesAfter: 0 };
    const files: string[] = (await listFiles(dir)).filter((file) => isCompressible(file));
    const encodings: AssetEncoding[] = gzip ? ["br", "gzip"] : ["br"];

    const one = async (file: string): Promise<void> => {
        const stat: fs.Stats = await fs.promises.stat(file);
        if (stat.size < minBytes) {
            result.skipped++;
            return;
        }
        let source: Buffer | undefined;
        let wrote: boolean = false;
        let smallest: number = stat.size;
        for (const encoding of encodings) {
            const target: string = file + ENCODING_EXTENSIONS[encoding];
            const existing: fs.Stats | undefined = await fs.promises.stat(target).catch(() => undefined);
            if (existing?.isFile() && existing.mtimeMs >= stat.mtimeMs) {
                smallest = Math.min(smallest, existing.size);
                continue;
            }
            source ??= await fs.promises.readFile(file);
            const data: Buffer = await compressBuffer(source, encoding, brotliQuality);
            if (data.length >= stat.size) {
                await fs.promises.rm(target, { force: true });
                continue;
            }
            await fs.promises.writeFile(target, data);
            smallest = Math.min(smallest, data.length);
            wrote = true;
        }
        if (wrote) {
            result.compressed++;
            result.bytesBefore += stat.size;
            result.bytesAfter += smallest;
        } else {
            result.skipped++;
        }
    };

    let next: number = 0;
    const worker = async (): Promise<void> => {
        while (next < files.length) {
            await one(files[next++]);
        }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, files.length)) }, worker));
    return result;
}

/** What `StaticAssetServer.respond()` decided: a status, the headers to send, and the body (none for 304, or HEAD's counterpart). */
export interface StaticAssetResponse {
    status: 200 | 304 | 400 | 404;
    headers: Record<string, string>;
    body?: Buffer;
    /** The size of the body a GET would send, for a HEAD response's `Content-Length`. */
    contentLength?: number;
}

export interface StaticAssetOptions {
    /** Send `Content-Encoding` variants. Default true. Turn off when nothing in front of the server may see them. */
    compress?: boolean;
    /** A production run trusts pre-compressed siblings and caches un-fingerprinted files for an hour; otherwise they revalidate. */
    production?: boolean;
    /** The most memory the file/variant cache may hold, in bytes. Default 64 MiB. */
    maxCacheBytes?: number;
    /** Brotli quality for variants made on the fly (cached, so paid once per file). Default 9. */
    brotliQuality?: number;
}

export const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";
export const REVALIDATE_CACHE_CONTROL = "no-cache";
export const STATIC_CACHE_CONTROL = "public, max-age=3600";

interface CacheEntry {
    mtimeMs: number;
    size: number;
    bytes: number;
    identity?: Promise<Buffer>;
    /** A variant that turned out not smaller than the file is remembered as `null`. */
    variants: Map<AssetEncoding, Promise<Buffer | null>>;
}

/**
 * Serves the browser bundles and static files of a Vite build folder the way a browser expects: the right
 * `Content-Type` (`.wasm` included), `ETag` with `If-None-Match` -> 304, `Cache-Control` (fingerprinted bundles cached
 * for a year and marked immutable, everything else revalidated or cached briefly), and brotli/gzip. Compressed variants
 * come from `.br`/`.gz` files written at build time (`precompressDirectory`) when present, else are made on the first
 * request and kept in memory, so nothing is compressed twice. It has no HTTP framework in it: `respond()` returns what
 * to send.
 */
export class StaticAssetServer {
    private readonly cache: Map<string, CacheEntry> = new Map();
    private cachedBytes: number = 0;
    private readonly options: Required<StaticAssetOptions>;

    constructor(options: StaticAssetOptions = {}) {
        this.options = {
            compress: options.compress ?? true,
            production: options.production ?? process.env.NODE_ENV === "production",
            maxCacheBytes: options.maxCacheBytes ?? 64 * 1024 * 1024,
            brotliQuality: options.brotliQuality ?? 9,
        };
    }

    /** Empties the memory cache. */
    public clear(): void {
        this.cache.clear();
        this.cachedBytes = 0;
    }

    /** Bytes currently held by the memory cache. */
    public get cacheSize(): number {
        return this.cachedBytes;
    }

    /**
     * The response for a GET or HEAD of `urlPath` (the request path, e.g. `/assets/client-2ASwhfpx.js`) from the build
     * folder `root`. Only files at or below `root` are ever read; a name with a dot segment or a dot file/folder anywhere
     * in it (`..`, `.vite`) is a 404.
     */
    public async respond(root: string, urlPath: string, requestHeaders: Record<string, string | string[] | undefined>): Promise<StaticAssetResponse> {
        const notFound: StaticAssetResponse = {
            status: 404,
            headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" },
            body: Buffer.from("Not Found"),
            contentLength: 9,
        };
        let decoded: string;
        try {
            decoded = decodeURIComponent(urlPath);
        } catch {
            return { ...notFound, status: 400, body: Buffer.from("Bad Request"), contentLength: 11 };
        }
        const segments: string[] = decoded.split("/").filter((segment) => segment.length > 0);
        if (segments.length === 0 || decoded.includes("\0") || decoded.includes("\\") || segments.some((segment) => segment.startsWith(".") || segment.includes(":"))) {
            return notFound;
        }
        const base: string = path.resolve(root);
        const file: string = path.resolve(base, ...segments);
        if (!file.startsWith(base + path.sep)) {
            return notFound;
        }
        let stat: fs.Stats;
        try {
            stat = await fs.promises.stat(file);
        } catch {
            return notFound;
        }
        if (!stat.isFile()) {
            return notFound;
        }

        const relative: string = segments.join("/");
        const compressible: boolean = this.options.compress && isCompressible(file) && stat.size >= MIN_COMPRESS_BYTES;
        let encoding: AssetEncoding | undefined = compressible ? preferredEncoding(requestHeaders["accept-encoding"]) : undefined;
        const validator: string = `${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}`;
        const etagFor = (used: AssetEncoding | undefined): string => (used ? `W/"${validator}-${used}"` : `"${validator}"`);

        const headers: Record<string, string> = {
            "content-type": assetMimeType(file),
            "cache-control": this.cacheControl(relative, file),
            "x-content-type-options": "nosniff",
        };
        if (compressible) {
            headers["vary"] = "Accept-Encoding";
        }
        if (etagMatches(requestHeaders["if-none-match"], etagFor(encoding))) {
            return { status: 304, headers: { ...headers, etag: etagFor(encoding) } };
        }

        let body: Buffer;
        try {
            const loaded: { body: Buffer; encoding?: AssetEncoding } = await this.load(file, stat, encoding);
            body = loaded.body;
            encoding = loaded.encoding;
        } catch {
            // Removed or unreadable between the stat and the read.
            return notFound;
        }
        headers["etag"] = etagFor(encoding);
        if (encoding) {
            headers["content-encoding"] = encoding;
        }
        return { status: 200, headers, body, contentLength: body.length };
    }

    /** `Cache-Control` for `relative` (its path below the build folder). */
    private cacheControl(relative: string, file: string): string {
        if (isFingerprintedAsset(relative)) {
            return IMMUTABLE_CACHE_CONTROL;
        }
        // Code and markup can change with a release under the same name: always revalidate (a 304 costs no body).
        // Images, fonts and the like rarely do, so a browser may reuse them for an hour.
        return this.options.production && !/^\.(css|js|mjs|cjs|json|map|html?|webmanifest|xml|txt)$/i.test(path.extname(file)) ? STATIC_CACHE_CONTROL : REVALIDATE_CACHE_CONTROL;
    }

    private entryFor(file: string, stat: fs.Stats): CacheEntry {
        const existing: CacheEntry | undefined = this.cache.get(file);
        if (existing && existing.mtimeMs === stat.mtimeMs && existing.size === stat.size) {
            // Most recently used goes last, so the first entry is the one to evict.
            this.cache.delete(file);
            this.cache.set(file, existing);
            return existing;
        }
        if (existing) {
            this.cachedBytes -= existing.bytes;
            this.cache.delete(file);
        }
        const created: CacheEntry = { mtimeMs: stat.mtimeMs, size: stat.size, bytes: 0, variants: new Map() };
        this.cache.set(file, created);
        return created;
    }

    private account(file: string, entry: CacheEntry, bytes: number): void {
        entry.bytes += bytes;
        if (this.cache.get(file) === entry) {
            this.cachedBytes += bytes;
            for (const [key, oldest] of this.cache) {
                if (this.cachedBytes <= this.options.maxCacheBytes) {
                    break;
                }
                this.cache.delete(key);
                this.cachedBytes -= oldest.bytes;
            }
        }
    }

    private async load(file: string, stat: fs.Stats, encoding?: AssetEncoding): Promise<{ body: Buffer; encoding?: AssetEncoding }> {
        const entry: CacheEntry = this.entryFor(file, stat);
        const identity = (): Promise<Buffer> => {
            if (!entry.identity) {
                entry.identity = fs.promises.readFile(file).then(
                    (data) => {
                        this.account(file, entry, data.length);
                        return data;
                    },
                    (err) => {
                        entry.identity = undefined;
                        throw err;
                    },
                );
            }
            return entry.identity;
        };
        if (!encoding) {
            return { body: await identity() };
        }
        let variant: Promise<Buffer | null> | undefined = entry.variants.get(encoding);
        if (!variant) {
            variant = this.makeVariant(file, stat, encoding, identity).then(
                (data) => {
                    if (data) {
                        this.account(file, entry, data.length);
                    }
                    return data;
                },
                (err) => {
                    entry.variants.delete(encoding);
                    throw err;
                },
            );
            entry.variants.set(encoding, variant);
        }
        const data: Buffer | null = await variant;
        return data ? { body: data, encoding } : { body: await identity() };
    }

    /** The compressed bytes for `file`: its build-time sibling if there is a fresh one, else compressed now. `null` if it doesn't shrink. */
    private async makeVariant(file: string, stat: fs.Stats, encoding: AssetEncoding, identity: () => Promise<Buffer>): Promise<Buffer | null> {
        let data: Buffer | undefined;
        if (this.options.production) {
            const sibling: string = file + ENCODING_EXTENSIONS[encoding];
            try {
                const siblingStat: fs.Stats = await fs.promises.stat(sibling);
                if (siblingStat.isFile() && siblingStat.mtimeMs >= stat.mtimeMs) {
                    data = await fs.promises.readFile(sibling);
                }
            } catch {
                // No pre-compressed sibling: compress here.
            }
        }
        data ??= await compressBuffer(await identity(), encoding, this.options.brotliQuality);
        return data.length < stat.size ? data : null;
    }
}
