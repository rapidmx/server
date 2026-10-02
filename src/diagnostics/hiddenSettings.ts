///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////

/**
 * The settings whose value the Diagnostics never shows, listed by name. Only a name on this list is hidden: every other
 * environment variable and setting is shown, so what is hidden is a decision someone made, not a guess from the look of a name.
 * That puts the upkeep here: a new secret in the server or in restapi is added below, and a plugin marks its own with
 * `secret: true` in its manifest's `settings` (see `hideSettings()`, which the plugin host calls for every loaded plugin).
 *
 * A name is written as the configuration key (`a:b:c`). The environment spells the same setting `a__b__c`, and the comparison
 * ignores case, so one entry covers both. An entry also hides everything beneath it (`default_accounts` hides each key of it).
 *
 * What is shown is still scrubbed by value (`scrubValue()` in redaction.ts): a URL's `user:password@`, a private key, a JWT,
 * a `Bearer` token or a `password=...` pair are removed or hide the whole value, under any name.
 */
export const CORE_HIDDEN_SETTINGS: readonly string[] = [
    // The server's own secrets.
    "auth:secret",
    "cookie_secret",
    "session:secret",
    "default_accounts",
    "mail:transport:ingest:secret",
    "mail:escrow:audit_hmac_key",
    "mail:scan:spam:rspamd:controller_password",
    "mail:search:opensearch:password",
    "mail:pki:openbao:token",
    "giphy:api_key",
    "system:plugins:registry_token",
    // The video conferencing plugin's (meet-plugin) secrets, until its manifest says so with `secret: true`.
    "mail:videoconf:turn:credential",
    "mail:videoconf:turn:shared_secret",
];

/** Names plugins have declared secret: not part of the code, but of what was installed. */
const declared: Set<string> = new Set();

/** `a__b__C` and `a:b:c` are the same setting. */
function normalize(name: string): string {
    return name.trim().toLowerCase().replace(/__/g, ":");
}

/** Hides the settings (configuration keys) that an installed plugin's manifest declares `secret: true`. */
export function hideSettings(names: readonly string[]): void {
    for (const name of names) {
        if (name.trim() !== "") {
            declared.add(normalize(name));
        }
    }
}

/** Forgets the names plugins declared (the plugin set is rebuilt from scratch when the server restarts, and in tests). */
export function resetHiddenSettings(): void {
    declared.clear();
}

/** Whether the value of the environment variable or setting `name` is hidden: it, or a setting above it, is on the list. */
export function isHiddenSetting(name: string): boolean {
    const normalized: string = normalize(name);
    const listed = (entry: string) => normalized === entry || normalized.startsWith(`${entry}:`);
    return CORE_HIDDEN_SETTINGS.some(listed) || [...declared].some(listed);
}
