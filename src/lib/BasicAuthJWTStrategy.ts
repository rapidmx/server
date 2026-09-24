///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { createHash } from "crypto";
import { ApiError, ObjectDecorators } from "@rapidrest/core";
import {
    ApiErrors,
    ModelUtils,
    RepoUtils,
    type AuthResult,
    type AuthStrategy,
    type HttpRequest,
    type HttpResponse,
    type ObjectFactory,
} from "@rapidrest/service-core";
import { clientAddress, rateLimitAddress, trustedProxyList } from "./TieredRateLimiter.js";
import type net from "net";
const { Config, Logger } = ObjectDecorators;

/** The paths (and everything under them) that speak a protocol whose clients can only send HTTP Basic credentials. */
export const DEFAULT_BASIC_AUTH_PATHS: readonly string[] = ["/mapi", "/Microsoft-Server-ActiveSync"];

/** Where auth-server answers a Basic login with an access token (`BaseAuthBasicRoute`, mounted at `/auth/password`). */
const AUTH_SERVER_LOGIN_PATH = "/api/auth/password";

/** How long auth-server may take to answer before the login counts as unavailable. */
const AUTH_SERVER_TIMEOUT_MS = 10_000;

/** A token this close to its expiry is not worth keeping: the next request logs in again. */
const TOKEN_EXPIRY_MARGIN_MS = 5_000;

/** The credentials of an `Authorization: Basic` header, or `undefined` when it isn't one or doesn't decode to `name:password`. */
export function parseBasicCredentials(header: string | string[] | undefined): { name: string; password: string } | undefined {
    const value: string | undefined = Array.isArray(header) ? header.find((entry) => /^basic\s/i.test(entry)) : header;
    const match: RegExpMatchArray | null | undefined = value?.match(/^basic\s+([A-Za-z0-9+/=_-]+)\s*$/i);
    if (!match) {
        return undefined;
    }
    const decoded: string = Buffer.from(match[1], "base64").toString("utf-8");
    const separator: number = decoded.indexOf(":");
    if (separator <= 0) {
        return undefined;
    }
    return { name: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
}

/** Whether `path` is `prefix` or below it, ignoring case - `/mapi` covers `/mapi/emsmdb` but not `/mapiary`. */
export function pathIsUnder(path: string, prefix: string): boolean {
    const candidate: string = path.toLowerCase();
    const base: string = prefix.toLowerCase().replace(/\/+$/, "");
    return candidate === base || candidate.startsWith(`${base}/`);
}

interface Failures {
    count: number;
    since: number;
}

/**
 * Lets the protocols whose clients cannot send anything but HTTP Basic credentials - Outlook's MAPI/HTTP and Exchange
 * ActiveSync - sign in with a username and an app password, on top of the JWT every other request carries.
 *
 * It stands in for the `jwt` strategy (same name, so every route that asks for `@Auth(["jwt"])` keeps working unchanged) and
 * asks the real one first. Only when that finds nothing, and the request is for one of the configured paths, is a `Basic`
 * header considered: the credentials are checked by auth-server (`GET /api/auth/password`, the endpoint it provides for exactly
 * this - "a mail server validating a legacy mail client's credentials"), whose answer is an ordinary access token that the real
 * JWT strategy then verifies like any other. So who a user is, whether a password is right, and that an account with
 * two-factor sign-in on can only use an app password all stay auth-server's decisions; nothing here stores or compares a password.
 *
 * Only the configured paths: an app password signs a user in without a second factor, so it is accepted where a client can
 * offer nothing else and nowhere else - not on the REST API, and not on the admin or webmail pages.
 *
 * A username that is a mailbox address (what Outlook and phones send) is resolved to the mailbox's owner and checked as
 * them; anything else (a username, a uid) goes to auth-server as it is.
 *
 * A logged-in credential is remembered for `cache_ttl_ms` (never past the token's own expiry), keyed by a hash of the header,
 * because these clients send their credentials with every request and each login is a session in auth-server.
 *
 * Repeated failures are throttled per client address and per username, so a guessing client is stopped here rather than
 * spending auth-server's attempts (which it counts against this server's address, not the client's).
 *
 * A 401 for those paths carries `WWW-Authenticate: Basic`, which is what makes a client ask for credentials at all.
 */
export class BasicAuthJWTStrategy implements AuthStrategy {
    /** Must be exactly `"jwt"` - this replaces whatever is registered under that name in `AuthMiddleware`. */
    public readonly name: string = "jwt";

    @Config("mail:basic_auth:enabled", true)
    protected enabled: boolean = true;

    @Config("mail:basic_auth:paths", [...DEFAULT_BASIC_AUTH_PATHS])
    protected paths: string[] = [...DEFAULT_BASIC_AUTH_PATHS];

    @Config("mail:basic_auth:realm", "RapidMX")
    protected realm: string = "RapidMX";

    @Config("mail:basic_auth:cache_ttl_ms", 300_000)
    protected cacheTtlMs: number = 300_000;

    @Config("mail:basic_auth:cache_max_entries", 5000)
    protected cacheMaxEntries: number = 5000;

    @Config("mail:basic_auth:failure_limit", 10)
    protected failureLimit: number = 10;

    @Config("mail:basic_auth:failure_window_ms", 900_000)
    protected failureWindowMs: number = 900_000;

    @Config("mail:auth_server_url", "")
    protected authServerUrl: string = "";

    @Config("trusted_proxies", [])
    protected trustedProxies: string[] = [];

    @Logger
    protected logger: any;

    /** Access token per hash of the `Authorization` header that produced it, with when to stop trusting it. */
    private readonly tokens: Map<string, { token: string; until: number }> = new Map();

    /** Failed logins, per client address and per lower-cased username, in the current window. */
    private readonly failures: Map<string, Failures> = new Map();

    private mailboxRepo?: RepoUtils<any>;

    /** `trusted_proxies` as a list that takes CIDR ranges, made on first use. */
    private trustedList?: net.BlockList;

    /**
     * @param inner The strategy that verifies JWTs - the real `jwt` one.
     * @param objectFactory Builds the mailbox repository, on first use (the datastores are not connected yet when this is made).
     * @param mailboxClass The backend's `Mailbox` model, for resolving a mailbox address to its owner.
     * @param fetcher `fetch`, replaceable for a test.
     */
    constructor(
        private readonly inner: AuthStrategy,
        private readonly objectFactory?: ObjectFactory,
        private readonly mailboxClass?: any,
        private readonly fetcher: typeof fetch = (input, init) => fetch(input, init),
    ) {}

    public async authenticate(req: HttpRequest, res?: HttpResponse): Promise<AuthResult | undefined> {
        let failure: unknown;
        try {
            const result: AuthResult | undefined = await this.inner.authenticate(req, res);
            if (result?.user) {
                return result;
            }
        } catch (err) {
            // A bad token of the kind the real strategy reads; still worth trying Basic where a client can send it.
            failure = err;
        }
        if (this.appliesTo(req)) {
            const authenticated: AuthResult | undefined = await this.authenticateBasic(req, res);
            if (authenticated) {
                return authenticated;
            }
        }
        if (failure) {
            throw failure;
        }
        return undefined;
    }

    public authenticateSync(req: HttpRequest, res?: HttpResponse): AuthResult | undefined {
        // A login needs a request to auth-server, so Basic credentials can't be checked synchronously.
        return this.inner.authenticateSync(req, res);
    }

    /** Whether Basic credentials are accepted for this request: enabled, an auth-server to ask, and one of the configured paths. */
    private appliesTo(req: HttpRequest): boolean {
        return this.enabled && !!this.authServerUrl && this.paths.some((prefix) => pathIsUnder(req.path ?? "", prefix));
    }

    private async authenticateBasic(req: HttpRequest, res?: HttpResponse): Promise<AuthResult | undefined> {
        const header: string | undefined = this.basicHeader(req);
        const credentials = parseBasicCredentials(header);
        if (!header || !credentials) {
            // Nothing to check: ask the client for credentials.
            this.challenge(res);
            return undefined;
        }

        const key: string = createHash("sha256").update(header).digest("hex");
        const cached: AuthResult | undefined = await this.fromCache(req, key);
        if (cached) {
            return cached;
        }

        // The client's address the way the rate limiter resolves it: behind a trusted proxy (the gateway), the nearest address that isn't one.
        this.trustedList ??= trustedProxyList(this.trustedProxies);
        const resolved: string | undefined = clientAddress(req, this.trustedList);
        const address: string = resolved ? rateLimitAddress(resolved) : "unknown";
        const identifiers: string[] = [`ip:${address}`, `name:${credentials.name.toLowerCase()}`];
        if (identifiers.some((identifier) => this.isThrottled(identifier))) {
            throw new ApiError(ApiErrors.AUTH_PERMISSION_FAILURE, 429, "Too many failed sign-in attempts. Try again later.");
        }

        const token: string | undefined = await this.login(req, header, credentials.name, address);
        const result: AuthResult | undefined = token ? await this.verify(req, token) : undefined;
        if (!result?.user) {
            for (const identifier of identifiers) {
                this.noteFailure(identifier);
            }
            this.challenge(res);
            return undefined;
        }

        this.failures.delete(identifiers[1]);
        this.remember(key, token!, result);
        return result;
    }

    /** The `Authorization` header value that is Basic, if there is one. */
    private basicHeader(req: HttpRequest): string | undefined {
        const value = req.headers?.authorization;
        const header: string | undefined = Array.isArray(value) ? value.find((entry) => /^basic\s/i.test(entry)) : value;
        return header && /^basic\s/i.test(header) ? header : undefined;
    }

    private challenge(res?: HttpResponse): void {
        res?.setHeader("WWW-Authenticate", `Basic realm="${this.realm.replace(/["\\]/g, "")}", charset="UTF-8"`);
    }

    /** The access token auth-server gives for these credentials, or `undefined` when it refuses them. Throws when it can't be asked. */
    private async login(req: HttpRequest, header: string, name: string, address: string): Promise<string | undefined> {
        const owner: string | undefined = name.includes("@") ? await this.ownerOf(name) : undefined;
        // The mailbox's owner is checked, by uid; a username auth-server knows (or a uid) goes as it is.
        const authorization: string =
            owner === undefined ? header : `Basic ${Buffer.from(`${owner}:${parseBasicCredentials(header)!.password}`).toString("base64")}`;
        let response: Response;
        try {
            response = await this.fetcher(`${this.authServerUrl.replace(/\/+$/, "")}${AUTH_SERVER_LOGIN_PATH}`, {
                method: "GET",
                headers: {
                    Authorization: authorization,
                    Accept: "application/json",
                    // So auth-server can count attempts against the client's address where it trusts this one.
                    "X-Forwarded-For": address,
                },
                signal: AbortSignal.timeout(AUTH_SERVER_TIMEOUT_MS),
            });
        } catch (err: any) {
            this.logger?.warn(`Basic sign-in could not reach auth-server: ${err?.message ?? err}`);
            throw new ApiError(ApiErrors.INTERNAL_ERROR, 503, "The sign-in service is unavailable.");
        }
        if (response.status === 401 || response.status === 403 || response.status === 429) {
            return undefined;
        }
        if (!response.ok) {
            this.logger?.warn(`Basic sign-in got HTTP ${response.status} from auth-server.`);
            throw new ApiError(ApiErrors.INTERNAL_ERROR, 503, "The sign-in service is unavailable.");
        }
        const body: any = await response.json().catch(() => undefined);
        return typeof body?.token === "string" ? body.token : undefined;
    }

    /** The uid of the person who owns the mailbox with this primary address, when there is such a mailbox. */
    private async ownerOf(address: string): Promise<string | undefined> {
        if (!this.objectFactory || !this.mailboxClass) {
            return undefined;
        }
        try {
            this.mailboxRepo ??= await this.objectFactory.newInstance(RepoUtils, {
                name: this.mailboxClass.name,
                args: [this.mailboxClass],
            });
            const normalized: string = address.trim().toLowerCase();
            const [mailbox] = await this.mailboxRepo.find({ primarySmtpAddress: ModelUtils.literal(normalized), limit: 1 }, { ignoreACL: true, limit: 1 });
            return mailbox?.ownerUserUid || undefined;
        } catch (err: any) {
            this.logger?.warn(`Could not look up the mailbox for a Basic sign-in: ${err?.message ?? err}`);
            throw new ApiError(ApiErrors.INTERNAL_ERROR, 503, "The sign-in service is unavailable.");
        }
    }

    /** Runs `token` through the real JWT strategy, as though it had come in as `Authorization: Bearer`, and nothing else had. */
    private async verify(req: HttpRequest, token: string): Promise<AuthResult | undefined> {
        const headers: Record<string, any> = { ...req.headers, authorization: `Bearer ${token}` };
        const tokenRequest: HttpRequest = Object.create(req, {
            cookies: { value: {}, enumerable: true, writable: true },
            headers: { value: headers, enumerable: true, writable: true },
            query: { value: {}, enumerable: true, writable: true },
            signedCookies: { value: {}, enumerable: true, writable: true },
        });
        try {
            return await this.inner.authenticate(tokenRequest);
        } catch (err: any) {
            // auth-server signed it with a secret, issuer or audience this server does not accept: a configuration fault.
            this.logger?.error(`A token from auth-server's Basic sign-in was not accepted: ${err?.message ?? err}`);
            return undefined;
        }
    }

    private async fromCache(req: HttpRequest, key: string): Promise<AuthResult | undefined> {
        const entry = this.tokens.get(key);
        if (!entry) {
            return undefined;
        }
        if (entry.until <= Date.now()) {
            this.tokens.delete(key);
            return undefined;
        }
        const result: AuthResult | undefined = await this.verify(req, entry.token);
        if (!result?.user) {
            this.tokens.delete(key);
            return undefined;
        }
        return result;
    }

    private remember(key: string, token: string, result: AuthResult): void {
        const expires: number | undefined = typeof result.payload?.exp === "number" ? result.payload.exp * 1000 : undefined;
        const until: number = Math.min(Date.now() + this.cacheTtlMs, (expires ?? Number.MAX_SAFE_INTEGER) - TOKEN_EXPIRY_MARGIN_MS);
        if (this.cacheTtlMs <= 0 || until <= Date.now()) {
            return;
        }
        this.tokens.delete(key);
        this.tokens.set(key, { token, until });
        // Oldest first: a Map iterates in insertion order.
        while (this.tokens.size > this.cacheMaxEntries) {
            this.tokens.delete(this.tokens.keys().next().value!);
        }
    }

    private isThrottled(identifier: string): boolean {
        const failures: Failures | undefined = this.failures.get(identifier);
        if (!failures) {
            return false;
        }
        if (Date.now() - failures.since > this.failureWindowMs) {
            this.failures.delete(identifier);
            return false;
        }
        return failures.count >= this.failureLimit;
    }

    private noteFailure(identifier: string): void {
        const now: number = Date.now();
        const failures: Failures | undefined = this.failures.get(identifier);
        if (failures && now - failures.since <= this.failureWindowMs) {
            failures.count += 1;
        } else {
            this.failures.set(identifier, { count: 1, since: now });
        }
        // Bounded: a flood of distinct names must not grow this without limit.
        while (this.failures.size > this.cacheMaxEntries * 4) {
            this.failures.delete(this.failures.keys().next().value!);
        }
    }
}
