///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ApiError, ObjectDecorators } from "@rapidrest/core";
import { ApiErrors, RouteDecorators } from "@rapidrest/service-core";
import { DEFAULT_GIPHY_API_KEY } from "../config.defaults.js";

const { Config } = ObjectDecorators;
const { Auth, Get, Query, RateLimit } = RouteDecorators;

/** The subset of a Giphy API result this app actually uses — never the raw Giphy payload, which
 * carries far more than a search grid needs (rendition variants, analytics IDs, etc.). */
export interface GiphyGif {
    id: string;
    /** A small rendition, for the search grid's thumbnails. */
    previewUrl: string;
    /** The full-resolution GIF — inserted into the message body when chosen. */
    url: string;
    title: string;
}

interface GiphyApiImage {
    url: string;
}

interface GiphyApiGif {
    id: string;
    title: string;
    images: {
        fixed_width_small?: GiphyApiImage;
        fixed_width?: GiphyApiImage;
        original?: GiphyApiImage;
    };
}

interface GiphyApiResponse {
    data: GiphyApiGif[];
}

const GIPHY_API_BASE = "https://api.giphy.com/v1/gifs";
const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 50;
/** How long a Giphy request may take before the search fails, so a slow upstream can't hold requests open. */
const FETCH_TIMEOUT_MS = 5_000;

/** `limit` as a whole number between 1 and `MAX_LIMIT`, or `DEFAULT_LIMIT` when missing or not a number. */
export function clampLimit(limitParam?: string): number {
    const parsed: number = limitParam === undefined ? NaN : parseInt(limitParam, 10);
    return Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), MAX_LIMIT) : DEFAULT_LIMIT;
}

function toGiphyGif(gif: GiphyApiGif): GiphyGif {
    return {
        id: gif.id,
        previewUrl: (gif.images.fixed_width_small ?? gif.images.fixed_width ?? gif.images.original)?.url ?? "",
        url: gif.images.original?.url ?? "",
        title: gif.title,
    };
}

/**
 * Proxies GIF search to Giphy's public API for the Compose window's "Insert GIF" button (see
 * `apps/shared/components/mail/compose/GifPicker.tsx`) — a proxy, not a direct client call, because
 * Giphy requires an API key, and a key embedded in the client bundle would be visible to anyone who
 * opens devtools. The key lives server-side only (`giphy:api_key`, no built-in default — the
 * feature is simply unavailable, not broken, until an operator sets one, matching
 * `mail:auto_provision`'s "disabled unless configured" convention). An empty/missing `q` returns
 * Giphy's trending feed instead of an empty result set, matching Giphy's own picker UX convention of
 * always showing *something* browsable before the user types a query.
 *
 * Duplicated into `src/mongo/routes/GiphySearchRoute.ts`/`src/sql/routes/GiphySearchRoute.ts` as a
 * one-line `@ApiRoute` subclass each, the same way `BaseMailComposeRoute` is — this project's
 * `ClassLoader` only auto-discovers route classes physically inside one of those two directories,
 * even for a route with no actual datastore dependency (`wwwRoute.ts` is the same shape, duplicated
 * for the identical reason).
 */
export class BaseGiphySearchRoute {
    @Config("giphy:api_key", undefined)
    private apiKey?: string;

    @Auth(["jwt"])
    // Every search spends this deployment's shared Giphy quota, so each user gets a modest budget of their own.
    @RateLimit({ perUser: true, maxAttempts: 30, windowSeconds: 60 })
    @Get("/search")
    public async search(@Query("q") query?: string, @Query("limit") limitParam?: string): Promise<GiphyGif[]> {
        // The checked-in placeholder key counts as unset.
        if (!this.apiKey || this.apiKey === DEFAULT_GIPHY_API_KEY) {
            throw new ApiError(ApiErrors.INTERNAL_ERROR, 500, "GIF search is not configured on this server.");
        }

        const limit: number = clampLimit(limitParam);
        const trimmed = query?.trim();
        const params = new URLSearchParams({ api_key: this.apiKey, limit: String(limit), rating: "pg-13" });
        if (trimmed) {
            params.set("q", trimmed);
        }

        let response: Response;
        try {
            response = await fetch(`${GIPHY_API_BASE}/${trimmed ? "search" : "trending"}?${params.toString()}`, {
                signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            });
        } catch {
            throw new ApiError(ApiErrors.INTERNAL_ERROR, 502, "Could not reach Giphy.");
        }
        if (!response.ok) {
            throw new ApiError(ApiErrors.INTERNAL_ERROR, 502, "Could not reach Giphy.");
        }

        const body = (await response.json()) as GiphyApiResponse;
        return body.data.map(toGiphyGif);
    }
}
