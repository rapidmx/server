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

/** The shortest `mail:transport:ingest:secret` a production deployment may use: it is a bearer secret that can be guessed at over HTTP. */
export const MIN_MAIL_INGEST_SECRET_LENGTH = 16;
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
 * Default cap, in bytes, on a background image a user uploads for the web client (`mail:preferences:background_max_bytes`,
 * `POST mail/preferences/appearance/background`) - 8MB, plenty for a photo at screen resolution. Shared here so both
 * `config.mongo.ts`/`config.sql.ts` (the default value) and `BaseAppearanceRoute` (the fallback when unset) agree on it. The
 * route answers 413 above it; `max_body_size` below is a separate, larger ceiling on every request.
 */
export const DEFAULT_APPEARANCE_BACKGROUND_MAX_BYTES = 8 * 1024 * 1024;
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
 * `NODE_ENV` values under which dev-only *behavioral* opt-ins (the dev auto-login route, `registerMailProviders()`'s
 * scan/transport bypass, skipping the shutdown drain delay) kick in. Anything else - including an unset, misspelled
 * or unexpected `NODE_ENV` (e.g. `staging`) - gets the real, production behavior.
 *
 * Deliberately **not** used by `assertProductionSecretsAreSet()` below - see `SECRETS_GUARD_SKIP_ENVIRONMENTS`'s own
 * doc comment for why the secrets guard needs a strictly narrower list than this one.
 */
export const DEVELOPMENT_ENVIRONMENTS: readonly string[] = ["dev", "development", "test"];

/**
 * `NODE_ENV` values under which the checked-in development default secrets are allowed to still be in effect.
 * Narrower than `DEVELOPMENT_ENVIRONMENTS` on purpose: `test` opts into every other dev-only behavior (the test suite
 * itself runs with `NODE_ENV=test`, e.g. `registerMailProviders.test.ts`/`enableDevAutoLogin.test.ts` both assert
 * `test` gets the same treatment as `dev`/`development`), but it is also exactly the value an operator would leave
 * behind on a real box by copying a `.env.test`-style file or a CI-oriented default into production - unlike `dev`/
 * `development`, nothing about the literal string `test` reliably signals "not a real deployment". Only an explicit
 * `dev`/`development` skips this specific guard; a real `NODE_ENV=test` deployment must still set its own secrets.
 */
export const SECRETS_GUARD_SKIP_ENVIRONMENTS: readonly string[] = ["dev", "development"];

/**
 * Refuses to let the server start with any of the checked-in development default secrets (`cookie_secret`,
 * `auth:secret`, `mail:transport:ingest:secret`) still in effect, or with one of them empty, unless `NODE_ENV` is
 * explicitly a development environment (`dev` or `development` - see `SECRETS_GUARD_SKIP_ENVIRONMENTS`, notably
 * `test` does **not** skip this check). The defaults are visible to anyone who reads this public repo, so leaving one
 * in place would let an attacker forge JWTs outright, or call the internal MTA hand-off route directly.
 *
 * @param config The loaded runtime configuration to check.
 * @param environment The raw `NODE_ENV`. Only `dev` and `development` skip the check.
 * @throws If any of the guarded secrets is empty or still holds its known default value outside development.
 */
export function assertProductionSecretsAreSet(config: SecretsConfig, environment: string | undefined): void {
    if (environment !== undefined && SECRETS_GUARD_SKIP_ENVIRONMENTS.includes(environment)) {
        return;
    }

    // Env var names as nconf reads them here: `.env({ separator: "__" })` with no prefix and no case conversion.
    const insecureDefaults: Array<{ envVar: string; value: unknown; expected: string }> = [
        { envVar: "cookie_secret", value: config.get("cookie_secret"), expected: DEFAULT_COOKIE_SECRET },
        { envVar: "auth__secret", value: config.get("auth:secret"), expected: DEFAULT_AUTH_SECRET },
        {
            envVar: "mail__transport__ingest__secret",
            value: config.get("mail:transport:ingest:secret"),
            expected: DEFAULT_MAIL_INGEST_SECRET,
        },
    ].filter((entry) => entry.value === entry.expected || String(entry.value ?? "").trim() === "");

    if (insecureDefaults.length > 0) {
        const names: string = insecureDefaults.map((entry) => entry.envVar).join(", ");
        throw new Error(
            `Refusing to start (NODE_ENV=${environment ?? "unset"}) with empty or default development secret(s): ${names}. ` +
                "Set the corresponding environment variable(s) to a unique, secret value before deploying, or set " +
                `NODE_ENV to one of ${SECRETS_GUARD_SKIP_ENVIRONMENTS.join("/")} for local development.`,
        );
    }
}

/**
 * The startup warning for a `mail:transport:ingest:secret` shorter than `MIN_MAIL_INGEST_SECRET_LENGTH`, or `undefined` when it is
 * long enough, empty or the development default (the secrets check handles those). It is a bearer secret that can be guessed at over
 * HTTP, but it is a warning rather than a refusal to start: an install that already has a short one would otherwise crash-loop on
 * upgrade, and the secret it has to be rotated to is also in postfix-bridge and ses-bridge.
 */
export function weakIngestSecretWarning(config: SecretsConfig, environment: string | undefined): string | undefined {
    if (environment !== undefined && SECRETS_GUARD_SKIP_ENVIRONMENTS.includes(environment)) {
        return undefined;
    }
    const secret: string = String(config.get("mail:transport:ingest:secret") ?? "").trim();
    if (secret === "" || secret === DEFAULT_MAIL_INGEST_SECRET || secret.length >= MIN_MAIL_INGEST_SECRET_LENGTH) {
        return undefined;
    }
    return (
        `mail__transport__ingest__secret (Helm mail.ingestSecret) is shorter than ${MIN_MAIL_INGEST_SECRET_LENGTH} characters: it is a ` +
        "bearer secret that can be guessed at over HTTP. Replace it, on the server and on every MTA bridge, with a random value, e.g. " +
        "the output of openssl rand -hex 32. A later release will refuse to start with it."
    );
}

/**
 * The startup warning for an empty `mail:security:trusted_authserv_id`, or `undefined` when it's set. Unset is a valid,
 * fail-closed choice (no Authentication-Results header is trusted), but it silently switches off mail features that
 * depend on a verified sender, so the server says so once at startup instead of leaving it to be discovered as mail
 * that went missing.
 */
export function trustedAuthservIdWarning(config: SecretsConfig): string | undefined {
    if (String(config.get("mail:security:trusted_authserv_id") ?? "").trim() !== "") {
        return undefined;
    }
    return (
        "mail:security:trusted_authserv_id (env mail__security__trusted_authserv_id, Helm mail.trustedAuthservId) is not set, " +
        "so no sender is DKIM-verified: messages to members-only distribution lists are dropped, list and forward-rule copies " +
        "are sent with a rewritten From, forwarded calendar invites are refused, and key discovery, read receipts, iTIP " +
        "replies, recalls and ACME email challenges are ignored. Set it to the authserv-id your inbound MTA stamps."
    );
}

/**
 * The startup warning for an empty `mail:escrow:audit_hmac_key`, or `undefined` when it's set (or in a development
 * environment, where the unkeyed fallback is expected). Without it the escrow audit log's hash chain is plain SHA-256, which
 * anyone with write access to the database can recompute after editing an entry - the log then proves nothing.
 */
export function escrowAuditKeyWarning(config: SecretsConfig, environment: string | undefined): string | undefined {
    if (String(config.get("mail:escrow:audit_hmac_key") ?? "").trim() !== "") {
        return undefined;
    }
    if (environment !== undefined && SECRETS_GUARD_SKIP_ENVIRONMENTS.includes(environment)) {
        return undefined;
    }
    return (
        "mail:escrow:audit_hmac_key (env mail__escrow__audit_hmac_key, Helm mail.escrow.auditHmacKey) is not set, so the escrow audit " +
        "log's hash chain is unkeyed SHA-256 that anyone with write access to the database can rewrite undetected. Set it to a " +
        "random value (it must be the same on every replica and must never change afterwards: entries chained under an old key stop verifying)."
    );
}

/**
 * The name of the nconf layer that holds the settings an administrator saved on plugins. It is the first layer, ahead of the
 * command line, the environment and the defaults, so a setting saved in the admin console always wins - the environment
 * (the Helm chart's, for one) is what applies until one is saved, and Reset in the console goes back to it.
 * `@rapidmx/restapi`'s `PLUGIN_SETTINGS_STORE` is the same name: it leaves this layer out when it reports what the
 * deployment itself configures.
 */
export const PLUGIN_SETTINGS_STORE = "plugins";

/**
 * Configuration a plugin's saved settings may never set, whatever its manifest declares: the backstop under
 * `isAllowedPluginSettingKey()`. They are applied in the top configuration layer, which outranks the environment and the
 * defaults and is read after `assertProductionSecretsAreSet()` has run, so a plugin manifest declaring one of these keys (or a
 * row in the plugin table written by someone with database access) could otherwise grant itself trusted roles, reintroduce a
 * default secret, point the server at another datastore, run a command (`mail:transport:sendmail:path`), redirect mail,
 * scanning, DNS or blob storage, or trust any proxy. Each entry is a key or the prefix of a whole group of keys (`auth` covers
 * `auth:secret`, `auth:options:issuer`...). A plugin's own settings live under its own namespace, like `mail:videoconf:*`.
 *
 * `@rapidmx/restapi`'s `PROTECTED_SETTING_NAMESPACES` (`BasePluginRoute`) is the same list, checked when a setting is saved;
 * it must be kept equal to this one, which is the source of truth, until it can be imported from there.
 */
export const PROTECTED_PLUGIN_SETTING_KEYS: readonly string[] = [
    "trusted_roles",
    "trusted_proxies",
    "auth",
    "cookie_secret",
    "cookies",
    "session",
    "cors",
    "ssl",
    "datastores",
    "base_path",
    "rateLimit",
    "telemetry_services",
    "service_name",
    "version",
    "max_body_size",
    "shutdown",
    "system",
    "metrics",
    "diagnostics",
    "class_loader",
    "cluster_url",
    "react",
    "static_assets",
    "giphy",
    "logs",
    "mail:transport",
    "mail:internal",
    "mail:escrow",
    "mail:pki",
    "mail:auth_server_url",
    "mail:basic_auth",
    "mail:security",
    "mail:blob",
    "mail:scan",
    "mail:dns",
    "mail:dkim",
    "mail:domains",
    "mail:auto_provision",
    "mail:default_quota_bytes",
    "mail:jobs",
    "mail:compose",
    "mail:search",
    "mail:preferences",
    "mail:autodiscover",
    "mail:branding",
];

function normalizeSettingKey(key: string): string {
    return key.trim().toLowerCase().replace(/__/g, ":");
}

/** Whether a plugin may not save a setting under `key` (see `PROTECTED_PLUGIN_SETTING_KEYS`). `__` counts as `:`, as in the environment. */
export function isProtectedPluginSettingKey(key: string): boolean {
    const normalized: string = normalizeSettingKey(key);
    return PROTECTED_PLUGIN_SETTING_KEYS.some((protectedKey) => {
        const prefix: string = protectedKey.toLowerCase();
        return normalized === prefix || normalized.startsWith(`${prefix}:`);
    });
}

/**
 * Whether a saved plugin setting may be applied: its key is one the installed plugin's manifest declares (`manifest.settings`),
 * and not one of the server's own (`isProtectedPluginSettingKey`). The settings come from the plugin table, which whoever can
 * write to the database can put any key in, so what is applied is decided here rather than by what the row holds.
 */
export function isAllowedPluginSettingKey(key: string, declaredKeys: Iterable<string>): boolean {
    const normalized: string = normalizeSettingKey(key);
    for (const declared of declaredKeys) {
        if (normalizeSettingKey(declared) === normalized) {
            return !isProtectedPluginSettingKey(key);
        }
    }
    return false;
}

/** The part of `nconf` `applyPluginSetting()` needs. */
export interface LayeredConfig {
    set(key: string, value: unknown): unknown;
    stores?: Record<string, any>;
}

/**
 * Puts a saved plugin setting in the `PLUGIN_SETTINGS_STORE` layer, where it outranks the environment. Without that layer
 * (a configuration made another way) it is `set()` like any other value.
 */
export function applyPluginSetting(config: LayeredConfig, key: string, value: unknown): void {
    const store = config.stores?.[PLUGIN_SETTINGS_STORE];
    if (!store) {
        config.set(key, value);
        return;
    }
    // nconf makes a literal store read-only, which is right for everything but writing this one.
    store.readOnly = false;
    try {
        store.set(key, value);
    } finally {
        store.readOnly = true;
    }
}

/** The part of `nconf` `ensurePushDatastore()` needs. */
export interface WritableConfig extends SecretsConfig {
    set(key: string, value: unknown): unknown;
}

/**
 * Gives the server the datastore `@rapidrest/service-core` publishes push events through. `Server.start()` creates its
 * `NotificationUtils` (which `ScanQueueJob`, `FolderCountUtils`, the delivery-failure notices and every other publisher of live
 * mail events call) only when a datastore named `notifications` exists, and nothing configures one: the `events` datastore is what
 * `/push` subscribes on, so it is the same Redis, but without the alias no event was ever published and the web client's live
 * inbox, folder counters and new mail pop-ups never heard of new mail until a reload.
 *
 * Copies the effective `events` datastore (including the `datastores__events__*` environment variables that point it at a
 * deployment's Redis, and `rapidrest dev`'s in-memory one) unless a `notifications` one is configured explicitly. Call it once,
 * after the defaults are set.
 */
export function ensurePushDatastore(config: WritableConfig): void {
    if (config.get("datastores:notifications") !== undefined) {
        return;
    }
    const events: unknown = config.get("datastores:events");
    if (events && typeof events === "object") {
        config.set("datastores:notifications", { ...(events as Record<string, unknown>) });
    }
}
