///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
import type { DiagnosticsSetting } from "./types.js";

/**
 * What the Diagnostics "Information" page may show of the server's environment variables and configuration. The page exists
 * for support, so it is deliberately allowed to be wrong in the direction of hiding too much, never too little.
 *
 * A name that looks like a secret is ALWAYS hidden (`isSecretName`), whatever its value and even if it is also on the
 * allowlist. A hidden setting is listed by name only: its value is never put in the response, so it cannot leak through the
 * client, a saved report, a proxy's logs or a screenshot. The UI's "hidden" text is rendered client-side from `redacted`.
 *
 * Environment variables are allowlist-first (`SHOWN_ENVIRONMENT`): a value is shown only for names known to be harmless
 * (NODE_ENV, TZ, *_HOST, *_PORT, ...). Every other name is hidden, because an unknown variable can hold anything.
 *
 * Configuration keys are the server's own settings, so they are shown unless the name is secret-like, but a value that is
 * itself shaped like a secret (private key block, JWT) is hidden, and every shown value is scrubbed (`scrubValue`).
 *
 * A URL loses its `user:password@` part and the value of any secret-named query parameter. A secret in a URL's path (a
 * webhook) cannot be recognized, so a name containing "webhook" is treated as secret and environment URLs are not allowlisted.
 */

/**
 * Names (an environment variable, or one segment of a configuration key) that are treated as holding a secret. A substring
 * match, case-insensitive and unanchored, so `mail__transport__ingest__secret`, `apiKey` and `DB_PASSWD` all match. It
 * over-matches on purpose (`auth:*` settings, `KEYBOARD`): hiding a harmless value costs a support question, leaking a secret
 * costs much more. `PWD` is not here: it is the working directory on Unix, and `PASSWORD`/`PASSWD` cover the rest.
 */
const SECRET_NAME =
    /(SECRET|PASS(WORD|WD|PHRASE)?|TOKEN|KEY|CREDENTIAL|AUTH|PRIVATE|COOKIE|SESSION|SALT|DSN|CONNECTION|CERT|SIGNATURE|BEARER|JWT|OAUTH|WEBHOOK|NONCE|SEED|HASH|OTP|LICENSE)/i;

/** Whether `name` looks like it holds a secret. The value is never consulted: a secret name wins over everything else. */
export function isSecretName(name: string): boolean {
    return SECRET_NAME.test(name);
}

/** Environment variable names whose value is shown (when the name is not secret-like either). Everything else is hidden. */
const SHOWN_ENVIRONMENT: RegExp[] = [
    /^(NODE_ENV|TZ|LANG|LANGUAGE|PORT|HOSTNAME|HOST|PWD|SHLVL|TERM|NODE_VERSION|YARN_VERSION)$/i,
    /^LC_[A-Z_]+$/i,
    // Hosts and ports, the chart's `service__name__host` style included: "HOST", "SMTP_HOST", "KUBERNETES_SERVICE_PORT".
    /(^|_)(HOST|HOSTNAME|PORT)$/i,
    // Plain switches and selectors in the `a__b__enabled` / `datastores__cache__type` convention.
    /(^|_)(ENABLED|DISABLED|TYPE|DATABASE|DOMAIN|SYNCHRONIZE|REGION|LEVEL|NAMESPACE)$/i,
];

/** A private key block, or three base64url parts joined with dots (a JWT): never shown even under an innocent name. */
const SECRET_VALUE = /-----BEGIN [A-Z0-9 ]*(PRIVATE KEY|CERTIFICATE)|\beyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]*/;

/**
 * `scheme://user:password@` (also `user@` alone): the credentials of a URL. Everything up to the last `@` of the run is taken,
 * so a password holding an unescaped `/` or `?` is removed whole rather than half-shown.
 */
const URL_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/)[^\s@]*@/gi;

/** `?name=value` / `&name=value` pairs whose name is secret-like. */
const SECRET_QUERY_PARAM = /([?&;])([^=&;#\s]*)=([^&;#\s]*)/g;

/** Longest value sent; anything longer is cut, so one stray blob cannot bloat the response. */
export const MAX_VALUE_LENGTH = 1000;

/**
 * The text that may be shown for `value`, or `undefined` when the whole value has to be hidden. URL credentials and secret
 * query parameters are removed; a value shaped like a private key or a JWT is hidden entirely.
 */
export function scrubValue(value: string): string | undefined {
    if (SECRET_VALUE.test(value)) {
        return undefined;
    }
    let scrubbed = value.replace(URL_CREDENTIALS, "$1");
    scrubbed = scrubbed.replace(SECRET_QUERY_PARAM, (match, sep: string, name: string) => (isSecretName(name) ? `${sep}${name}=` : match));
    return scrubbed.length > MAX_VALUE_LENGTH ? `${scrubbed.slice(0, MAX_VALUE_LENGTH)}...` : scrubbed;
}

function hidden(name: string): DiagnosticsSetting {
    return { name, redacted: true };
}

function shown(name: string, value: string): DiagnosticsSetting {
    const scrubbed = scrubValue(value);
    return scrubbed === undefined ? hidden(name) : { name, value: scrubbed, redacted: false };
}

const byName = (a: DiagnosticsSetting, b: DiagnosticsSetting) => a.name.localeCompare(b.name);

/** The process environment, sorted by name: secret-like and unknown names listed without a value, allowlisted ones scrubbed. */
export function describeEnvironment(env: NodeJS.ProcessEnv): DiagnosticsSetting[] {
    const settings: DiagnosticsSetting[] = [];
    for (const [name, value] of Object.entries(env)) {
        if (value === undefined) {
            continue;
        }
        const allowed = !isSecretName(name) && SHOWN_ENVIRONMENT.some((pattern) => pattern.test(name));
        settings.push(allowed ? shown(name, value) : hidden(name));
    }
    return settings.sort(byName);
}

/** How deep, and how many settings, a configuration tree is followed: a guard against a cyclic or enormous object. */
const MAX_DEPTH = 12;
const MAX_SETTINGS = 5000;

/**
 * Flattens a configuration tree into `a:b:c` names (nconf's own separator, so the names are what `@Config("a:b:c")` reads). A
 * secret-named key hides its whole subtree as one entry, so not even the shape of the secret is listed.
 */
function flatten(node: unknown, prefix: string, depth: number, seen: Set<unknown>, out: DiagnosticsSetting[]): void {
    if (out.length >= MAX_SETTINGS) {
        return;
    }
    if (node === undefined) {
        return;
    }
    if (node === null || typeof node !== "object") {
        out.push(typeof node === "function" ? hidden(prefix) : shown(prefix, String(node)));
        return;
    }
    if (seen.has(node) || depth >= MAX_DEPTH) {
        out.push(hidden(prefix));
        return;
    }
    seen.add(node);
    const entries = Array.isArray(node) ? node.map((item, index) => [String(index), item] as const) : Object.entries(node);
    if (entries.length === 0) {
        out.push(shown(prefix, Array.isArray(node) ? "[]" : "{}"));
    }
    for (const [key, child] of entries) {
        const name = `${prefix}:${key}`;
        if (isSecretName(key)) {
            out.push(hidden(name));
        } else {
            flatten(child, name, depth + 1, seen, out);
        }
    }
    seen.delete(node);
}

/**
 * The effective configuration (every nconf layer merged: arguments, environment, runtime and plugin settings, defaults),
 * flattened and sorted. The merged tree also holds every environment variable as a top-level key of its own name (nconf's env
 * layer); those are what the Environment list already covers, under its stricter allowlist, so a scalar top-level key that is
 * an environment variable and not one of the `declared` defaults is dropped rather than shown twice and unfiltered.
 *
 * @param tree The merged configuration object.
 * @param env The process environment.
 * @param declared The top-level keys the defaults layer declares (the server's own settings).
 */
export function describeConfiguration(tree: unknown, env: NodeJS.ProcessEnv, declared: readonly string[] = []): DiagnosticsSetting[] {
    const out: DiagnosticsSetting[] = [];
    if (tree === null || typeof tree !== "object") {
        return out;
    }
    const known = new Set(declared);
    for (const [key, child] of Object.entries(tree as Record<string, unknown>)) {
        // `_` and `$0` are the command line's positional arguments and script, not settings.
        if (key === "_" || key === "$0") {
            continue;
        }
        const isEnvironmentCopy = env[key] !== undefined && !known.has(key) && (child === null || typeof child !== "object");
        if (isEnvironmentCopy) {
            continue;
        }
        if (isSecretName(key)) {
            out.push(hidden(key));
        } else {
            flatten(child, key, 1, new Set(), out);
        }
    }
    return out.sort(byName);
}
