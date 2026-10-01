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
 * itself shaped like a secret (private key block, JWT, `password=...`) is hidden, and every shown value is scrubbed (`scrubValue`).
 *
 * A URL loses its `user:password@` part, and a value with a secret-named `name=value` pair is hidden whole. A secret in a
 * URL's path (a webhook) cannot be recognized, so a name containing "webhook" is treated as secret and environment URLs are
 * not allowlisted.
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
 * The start of a URL: `scheme://`. The lookbehind makes only the first character of a run of scheme characters a candidate
 * start, so a long unbroken run is scanned once, not once per character.
 */
const URL_SCHEME = /(?<![a-z0-9+.-])[a-z][a-z0-9+.-]*:\/\//gi;

/**
 * A `name=value` pair (a query parameter, a connection-string setting, a cookie): the name starts the value or follows one of
 * `? & ; , #` or whitespace, and is bounded so a long run of delimiters is not rescanned from every position. `value` is
 * the empty string for an empty value, which holds nothing to hide.
 */
const NAME_VALUE_PAIR = /(?<=^|[?&;,#\s])([^=&;,#?\s]{0,128})=([^&;,#\s]?)/g;

/** Secret names beyond `SECRET_NAME` that only occur as a whole word: `Pwd`, `pw`, an Azure SAS `sig`. */
const SECRET_PAIR_NAME = /(^|[^a-z])(pwd|pw|sig|sas|pat)([^a-z]|$)/i;

/** An opaque credential under any name: `Bearer abc`, `Basic dXNl...`, an `Authorization: ...` header. */
const OPAQUE_CREDENTIAL = /\b(bearer|basic)\s+\S|\bauthorization\s*[:=]/i;

/**
 * A `user:password@host` or `//user@host` left in a value that has no `scheme://`. The lead is the start of the value or a
 * delimiter, and the character classes leave out the delimiters so a long run is not rescanned from every one.
 */
const SCHEMELESS_USERINFO = /(?:^|[\s=,;(])(?:(?!mailto:)[^\s@:/?#=,;(]+:[^\s@/]*@\S|\/\/[^\s/@]*@\S)/i;

/** A host with an optional port (or a bracketed IPv6 address): what an authority without userinfo looks like. */
const PLAIN_AUTHORITY = /^(\[[0-9a-f:.]*\]|[^\s:@]*)(:\d*)?$/i;

/** Longest value sent; anything longer is cut, so one stray blob cannot bloat the response. */
export const MAX_VALUE_LENGTH = 1000;

/**
 * Longest value that is scrubbed at all. A longer one is hidden whole rather than cut first: cutting before scrubbing could
 * leave the start of a credential whose `@` fell past the cut.
 */
const MAX_SCRUBBED_LENGTH = MAX_VALUE_LENGTH * 10;

/**
 * `tail` is what follows a `scheme://`, up to the end of the value, and `nextStart` is where the next URL in it begins. Only
 * the authority, the part up to the first `/`, `?`, `#` or whitespace, can hold userinfo, so an `@` in a path or query
 * (`/@scope/pkg`, `?to=a@b.c`) is left alone. The userinfo is what precedes the authority's last `@` (a password may legally hold `@`) and is removed.
 *
 * A password may also hold `/`, `?`, `#`, whitespace or even `://`, which ends the authority early and leaves the start of
 * the password in what looks like the host. So an authority that is not a plain host and port, with an `@` anywhere after
 * it, has an unknowable extent and the value is hidden whole (`undefined`), as is one with another `scheme://` inside it.
 */
function stripUserinfo(tail: string, nextStart: number): string | undefined {
    const end = tail.search(/[/?#\s]|$/);
    if (nextStart < end) {
        return undefined;
    }
    const authority = tail.slice(0, end);
    const at = authority.lastIndexOf("@");
    if (at < 0) {
        return PLAIN_AUTHORITY.test(authority) || tail.indexOf("@", end) < 0 ? tail.slice(0, nextStart) : undefined;
    }
    return tail.slice(at + 1, nextStart);
}

/** `value` without the credentials of any URL in it, or `undefined` when they cannot be told apart from the rest. */
function stripUrlCredentials(value: string): string | undefined {
    const starts = [...value.matchAll(URL_SCHEME)];
    let out = value.slice(0, starts[0]?.index ?? value.length);
    for (let i = 0; i < starts.length; i++) {
        const head = starts[i];
        const from = head.index + head[0].length;
        const next = starts[i + 1]?.index ?? value.length;
        const rest = stripUserinfo(value.slice(from), next - from);
        if (rest === undefined) {
            return undefined;
        }
        out += head[0] + rest;
    }
    return out;
}

/** Whether a `name=value` pair in `value` has a secret-like name and a non-empty value. */
function hasSecretPair(value: string): boolean {
    for (const match of value.matchAll(NAME_VALUE_PAIR)) {
        if (match[2] !== "" && (isSecretName(match[1]) || SECRET_PAIR_NAME.test(match[1]))) {
            return true;
        }
    }
    return false;
}

/**
 * The text that may be shown for `value`, or `undefined` when the whole value has to be hidden. A value is either shown
 * exactly or hidden whole, never partly scrubbed: the credentials of a URL are removed only where their extent is certain,
 * and a value that holds a secret-named pair (`password=...`), a `Bearer`/`Basic` token, a private key or a JWT, or a
 * `user:password@host` it cannot place, is hidden entirely.
 */
export function scrubValue(value: string): string | undefined {
    if (value.length > MAX_SCRUBBED_LENGTH || SECRET_VALUE.test(value) || OPAQUE_CREDENTIAL.test(value) || hasSecretPair(value)) {
        return undefined;
    }
    const scrubbed = stripUrlCredentials(value);
    if (scrubbed === undefined || SCHEMELESS_USERINFO.test(scrubbed)) {
        return undefined;
    }
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
    // Only as many entries as the budget still lists are read, so a huge array or object is not materialised whole.
    const budget = MAX_SETTINGS - out.length;
    const entries = Array.isArray(node)
        ? node.slice(0, budget).map((item, index) => [String(index), item] as const)
        : Object.keys(node)
              .slice(0, budget)
              .map((key) => [key, (node as Record<string, unknown>)[key]] as const);
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
 * an environment variable and not one of the `declared` defaults is dropped rather than shown twice and unfiltered. That holds
 * whatever the value: `parseValues` turns a JSON value into an object, and the `__` separator turns `FOO__BAR` into a
 * `FOO` subtree, so a key is also dropped when it is the first segment of an environment name. Names compare case-insensitively.
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
    const environment = new Set(Object.keys(env).map((name) => name.split("__")[0].toLowerCase()));
    for (const [key, child] of Object.entries(tree as Record<string, unknown>)) {
        // `_` and `$0` are the command line's positional arguments and script, not settings.
        if (key === "_" || key === "$0") {
            continue;
        }
        if (!known.has(key) && environment.has(key.toLowerCase())) {
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
