///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * Default secret values used by `config.sql.ts`/`config.mongo.ts` for local development convenience.
 * Shared here (rather than duplicated in each config file) so `assertProductionSecretsAreSet()` can
 * compare the effective runtime config against the exact same values it's guarding against in
 * production.
 */
export const DEFAULT_COOKIE_SECRET = "f0fLSKFJLKWJFe09f32joff098u2fOFIWJ32890fnfnlak";
/**
 * `auth:secret` is used to **verify** JWTs issued by the separate `auth-server` deployment (see
 * `.claude/NOTES.md`) — this repo never issues its own tokens. In production this must be set to the
 * exact same signing secret `auth-server` uses, not just "a" secret; the two services will otherwise
 * reject each other's tokens entirely (auth-server's issued tokens will fail signature verification
 * here). Coordinate the real value via the deployment's shared secret store (see the Helm chart), not by
 * generating an independent one for this service alone.
 */
export const DEFAULT_AUTH_SECRET = "MyPasswordIsSecure";
/**
 * Authenticates the internal MTA hand-off route (`POST /internal/mta/deliver`, `GET /internal/mta/resolve`
 * — see `BaseMailIngestRoute`) via a constant-time bearer-secret comparison, not JWT. Must be set to a real
 * secret in production and shared only with the Postfix container that calls this route — never exposed
 * through the public ingress.
 */
export const DEFAULT_MAIL_INGEST_SECRET = "ChangeMeIngestSecret";
/**
 * Giphy's public Search API key, used by `BaseGiphySearchRoute`'s server-side GIF-search proxy (see
 * `giphy:api_key`). Unlike the three secrets above, a missing/placeholder value here doesn't expose an
 * auth-forgery risk — the route simply refuses GIF search with a clear "not configured" error — so this
 * one is not checked by `assertProductionSecretsAreSet()`. Set a real key via the deployment's config/env
 * to enable the feature; leaving this placeholder in effect just means GIF search stays disabled.
 */
export const DEFAULT_GIPHY_API_KEY = "ChangeMeGiphyApiKey";
/**
 * Default cap, in bytes, on the combined size of a draft's attachments `BaseMailComposeRoute.assemble()`
 * will load into memory at once to build MIME (`mail:compose:max_attachment_bytes`) — 25MB, matching the
 * common real-world mail provider limit (Gmail, Outlook). Shared here so both `config.mongo.ts`/
 * `config.sql.ts` (the default value) and `BaseMailComposeRoute` (the fallback when unset) agree on it.
 */
export const DEFAULT_MAX_COMPOSE_ATTACHMENT_BYTES = 25_000_000;
/**
 * Default cap, in bytes, on any single raw HTTP request body (`max_body_size`, read by
 * `@rapidrest/service-core`'s own `Server.js`) — the framework's own built-in default is a much smaller
 * 10 MiB, buffered entirely in memory per request before any route handler runs. Raised here to 100 MiB
 * so `BaseMailboxImportRoute.create()` (a raw-bytes Mbox/PST upload, `mail:mailbox-import-requests`) can
 * actually accept a realistically-sized personal mailbox export - a real day-to-day Mbox/PST archive
 * routinely exceeds 10MB, so leaving the framework default in place would make the entire import feature
 * unusable in practice. Kept deliberately moderate rather than raised further: this framework buffers a
 * request's whole body in memory before the route ever sees it, so a much higher global cap widens the
 * memory-exhaustion blast radius of *every* endpoint, not just this one - there is no per-route override,
 * only this single global value. A genuinely multi-gigabyte PST archive (a decades-old, never-archived
 * mailbox) will still exceed this and needs an operator to raise `max_body_size` further for their own
 * deployment - a disclosed, real limitation, not a bug. As a side effect, this also fixes a pre-existing,
 * unrelated gap: a single mail attachment upload (`uploadAttachment`) larger than 10MB already 413'd
 * before this change, well under `mail:compose:max_attachment_bytes`'s own 25MB budget above.
 */
export const DEFAULT_MAX_BODY_SIZE_BYTES = 100 * 1024 * 1024;

/** Minimal shape of the `nconf` config object this guard needs — matches `config.sql.ts`/`config.mongo.ts`'s export. */
export interface SecretsConfig {
    get(key: string): unknown;
}

/**
 * Refuses to let the server start in production with any of the checked-in development default
 * secrets (`cookie_secret`, `auth:secret`, `mail:transport:ingest:secret`) still in effect — they're
 * visible to anyone who reads this public repo, so leaving one unset in production would let an attacker
 * forge JWTs outright, or hit the internal MTA hand-off route directly.
 *
 * @param config The loaded runtime configuration to check.
 * @param environment The deployment environment (`process.env.NODE_ENV`, defaulting to `"production"`
 * when unset — see the server entry points). A no-op unless this is exactly `"production"`.
 * @throws If any of the guarded secrets still hold its known default value in production.
 */
export function assertProductionSecretsAreSet(config: SecretsConfig, environment: string | undefined): void {
    if (environment !== "production") {
        return;
    }

    const insecureDefaults: Array<{ envVar: string; value: unknown; expected: string }> = [
        { envVar: "COOKIE_SECRET", value: config.get("cookie_secret"), expected: DEFAULT_COOKIE_SECRET },
        { envVar: "AUTH__SECRET", value: config.get("auth:secret"), expected: DEFAULT_AUTH_SECRET },
        {
            envVar: "MAIL__TRANSPORT__INGEST__SECRET",
            value: config.get("mail:transport:ingest:secret"),
            expected: DEFAULT_MAIL_INGEST_SECRET,
        },
    ].filter((entry) => entry.value === entry.expected);

    if (insecureDefaults.length > 0) {
        const names: string = insecureDefaults.map((entry) => entry.envVar).join(", ");
        throw new Error(
            `Refusing to start in production with the default development secret(s) still in effect: ${names}. ` +
                "Set the corresponding environment variable(s) to a unique, secret value before deploying.",
        );
    }
}
