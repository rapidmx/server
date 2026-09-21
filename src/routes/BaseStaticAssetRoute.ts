///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ObjectDecorators } from "@rapidrest/core";
import { RouteDecorators, type HttpRequest, type HttpResponse } from "@rapidrest/service-core";
import path from "path";
import { StaticAssetServer, type StaticAssetResponse } from "../lib/staticAssets.js";

const { Config, Init } = ObjectDecorators;
const { Auth, Method, Request, Response } = RouteDecorators;

/**
 * The folders of the browser build (`dist/public`, or the plugin UI build that replaces it) that are served as static
 * files: Vite's `assets/` (the fingerprinted bundles), the folders `public/` is copied from, and its `favicon.ico`.
 */
export const STATIC_ASSET_PATHS: string[] = ["/assets", "/fonts", "/images", "/styles", "/favicon.ico"];

/**
 * Serves the browser build's static files (`GET`/`HEAD` under `STATIC_ASSET_PATHS`) with a proper `Content-Type`,
 * `ETag`/304, `Cache-Control` and brotli/gzip - see `StaticAssetServer`.
 *
 * `@rapidrest/react`'s `ReactRoute` also serves these files (from the same folder, `react:manifestPath`'s grandparent),
 * but sends no cache or encoding headers at all, has no `HEAD` and no `.wasm`. uWebSockets picks the most specific route
 * pattern, not the first registered, so `/assets/*` here wins over the pages' `/*` wherever they are mounted; a path
 * outside these folders is still `ReactRoute`'s. No auth strategy runs (nothing here is private, and the
 * JWT check would only cost time) and nothing is rate limited.
 *
 * The concrete routes (`mongo/routes/StaticAssetRoute.ts`, `sql/routes/StaticAssetRoute.ts`) only mount it.
 */
export class BaseStaticAssetRoute {
    /** The Vite manifest of the served build, `<outDir>/.vite/manifest.json`. */
    @Config("react:manifestPath", "")
    protected manifestPath: string = "";

    @Config("static_assets:compress", true)
    protected compress: boolean = true;

    @Config("static_assets:memory_cache_bytes", 64 * 1024 * 1024)
    protected memoryCacheBytes: number = 64 * 1024 * 1024;

    @Config("static_assets:brotli_quality", 9)
    protected brotliQuality: number = 9;

    private assets!: StaticAssetServer;

    @Init
    protected initStaticAssets(): void {
        this.assets = new StaticAssetServer({
            compress: this.compress !== false && String(this.compress) !== "false",
            maxCacheBytes: Number(this.memoryCacheBytes),
            brotliQuality: Number(this.brotliQuality),
        });
    }

    /** The build folder: Vite writes the manifest to `<outDir>/.vite/manifest.json` (the same derivation `ReactRoute` uses). */
    protected outDir(): string | undefined {
        return this.manifestPath ? path.resolve(process.cwd(), path.dirname(path.dirname(this.manifestPath))) : undefined;
    }

    /** A file below one of the folders, e.g. `/assets/client-2ASwhfpx.js`. */
    @Method(["get", "head"], "/*")
    @Auth([], false)
    public async serve(@Request req: HttpRequest, @Response res: HttpResponse): Promise<HttpResponse> {
        return await this.respond(req, res);
    }

    /** The mount path itself: `/favicon.ico`, or a folder's own path (a 404, not the pages' one). */
    @Method(["get", "head"], "")
    @Auth([], false)
    public async serveMount(@Request req: HttpRequest, @Response res: HttpResponse): Promise<HttpResponse> {
        return await this.respond(req, res);
    }

    private async respond(req: HttpRequest, res: HttpResponse): Promise<HttpResponse> {
        const outDir: string | undefined = this.outDir();
        const result: StaticAssetResponse = outDir
            ? await this.assets.respond(outDir, req.path, req.headers)
            : { status: 404, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }, body: Buffer.from("Not Found"), contentLength: 9 };
        res.status(result.status);
        for (const [name, value] of Object.entries(result.headers)) {
            res.setHeader(name, value);
        }
        // The CORS middleware answers a listed origin with its own `Access-Control-Allow-Origin`, so a cache in front must key on Origin too.
        const allowOrigin: string | string[] | undefined = res.getHeader("access-control-allow-origin");
        if (allowOrigin && allowOrigin !== "*" && result.headers["vary"]) {
            res.setHeader("vary", `${result.headers["vary"]}, Origin`);
        }
        if (result.contentLength !== undefined) {
            // Only a HEAD reply uses it (uWS adds the length of a GET body itself, and without one reports a bogus 2^63).
            res.setHeader("content-length", result.contentLength);
        }
        res.end(result.body);
        return res;
    }
}
