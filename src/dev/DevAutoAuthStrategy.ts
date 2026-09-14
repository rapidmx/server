///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * DEV-ONLY. Never registered outside of `yarn dev` — see `enableDevAutoLogin.ts`'s
 * `enableDevAutoLoginIfApplicable()`, the sole place this class is ever instantiated and wired in.
 * Auto-authenticates every request as a synthetic local user so the webmail/admin UIs are fully
 * usable against `yarn dev` without a real `auth-server` deployment running alongside this
 * service — that separate service is normally the *only* source of identity/JWTs (see
 * `.claude/NOTES.md`); this exists purely to skip standing one up for local development.
 *
 * Wraps the real JWT verification path rather than replacing it outright: an already-valid `jwt`
 * cookie (one this same class minted on a previous request, or a real one if an actual
 * auth-server happens to be running too) is honored as-is. Only when no cookie is present, or it
 * fails to verify (missing, expired, wrong secret), does this mint a fresh token for a synthetic
 * dev user and set it as the `jwt` cookie — via the exact same `JWTUtils`/`auth` config path a
 * real auth-server-issued token would use, so once set it's indistinguishable from a real session
 * to the rest of this codebase (including every `/api/**` route the webmail UI itself calls).
 *
 * @author Jean-Philippe Steinmetz
 */
import { JWTUtils, ObjectDecorators, type JWTPayload, type JWTUser } from "@rapidrest/core";
import type { AuthResult, AuthStrategy, HttpRequest, HttpResponse } from "@rapidrest/service-core";
const { Config, Logger } = ObjectDecorators;

/**
 * Matches `JWTStrategyOptions.cookieName`'s hardcoded default. The real `JWTStrategy` never
 * actually reads `auth:cookie:access:name` from config — that key is only consumed by
 * `@rapidrest/auth`'s own `TokenUtils`, a separate service — so this class doesn't either; it
 * mirrors what the cookie name actually is today, not what a config value implies it might be.
 */
const COOKIE_NAME = "jwt";

/**
 * The synthetic dev user's uid (`mail:dev_auto_login:uid` overrides it). A fixed UUID rather than a readable name:
 * `@rapidmx/restapi` only grants mailbox access to UUID-shaped uids, and validates `ownerUserUid` as a UUID, just as
 * real auth-server uids are.
 */
export const DEV_USER_UID = "00000000-0000-4000-8000-00000000de01";

export class DevAutoAuthStrategy implements AuthStrategy {
    /** Must be exactly `"jwt"` — this replaces whatever is registered under that name in `AuthMiddleware`. */
    public readonly name: string = "jwt";

    @Config("auth")
    private authConfig: any;

    @Config("mail:dev_auto_login:uid", DEV_USER_UID)
    private devUid: string = DEV_USER_UID;

    @Config("mail:dev_auto_login:roles", ["admin"])
    private devRoles: string[] = ["admin"];

    @Logger
    private logger: any;

    private buildDevUser(): JWTUser {
        return { uid: this.devUid, roles: this.devRoles, scopes: [], elevated: Date.now() };
    }

    /**
     * A `jwt` cookie decoding to this strategy's own synthetic dev uid, but missing a valid `elevated`
     * timestamp, must have been minted by an older version of `mint()` (before it started setting that
     * field) — stale, and must be re-minted rather than trusted as-is, or a browser session started
     * before that fix silently keeps failing every `RequiresElevation()`-gated endpoint (e.g. the admin
     * console's canary call) even after the code itself is fixed, since decoding an
     * old-but-structurally-valid token never fails on its own. Scoped to this exact uid specifically so
     * a real external auth-server-issued token for an actual (non-dev) user — legitimately unprivileged,
     * `elevated <= 0`, by the normal meaning of that field — is never second-guessed; only a token this
     * strategy itself could have minted is ever revalidated against its own current invariants.
     */
    private isStaleDevToken(user: JWTUser): boolean {
        return user.uid === this.devUid && !(typeof user.elevated === "number" && user.elevated > 0);
    }

    /** Plain http (no TLS) in local dev — a `Secure` cookie would never be sent back by the browser at all,
     * silently breaking every subsequent request's auth. */
    private setCookie(res: HttpResponse | undefined, token: string): void {
        res?.appendHeader("Set-Cookie", `${COOKIE_NAME}=${token}; Path=/; SameSite=Lax`);
    }

    /**
     * Deliberately synchronous (`JWTUtils.createTokenSync`, not the async `createToken`) so that setting the
     * `Set-Cookie` header never crosses an `await` — uWebSockets.js's `HttpResponse` object is only safe to
     * touch synchronously within the request callback, or after an explicit `res.cork()`/pause-resume dance;
     * calling `res.appendHeader()` after an `await` reproducibly crashed the whole process (confirmed by
     * removing just that call and watching the crash disappear). `mail:dev_auto_login`'s config doesn't use
     * password-based payload encryption, so `createTokenSync`'s own caveat (blocking the event loop while
     * deriving that encryption key) never applies here.
     */
    private mint(req: HttpRequest, res: HttpResponse | undefined): AuthResult {
        const user: JWTUser = this.buildDevUser();
        const token: string = JWTUtils.createTokenSync(this.authConfig, user);
        this.setCookie(res, token);
        this.logger?.warn(
            `[DevAutoAuthStrategy] No valid session for ${req.path ?? "request"} — auto-authenticated as ` +
                `'${user.uid}' (roles: ${user.roles.join(", ")}). yarn dev only; never active in production.`,
        );
        return { data: token, method: this.name, user };
    }

    public async authenticate(req: HttpRequest, res?: HttpResponse): Promise<AuthResult | undefined> {
        const token: string | undefined = req.cookies?.[COOKIE_NAME];
        if (token) {
            try {
                // A non-throwing decodeToken() always has a usable `.profile`: `finalizePayload` unconditionally
                // `JSON.parse`s it, which would itself throw (caught below) were it ever absent or malformed.
                const payload: JWTPayload = await JWTUtils.decodeToken(this.authConfig, token);
                const user = payload.profile as JWTUser;
                if (!this.isStaleDevToken(user)) {
                    return { data: token, method: this.name, payload, user };
                }
            } catch {
                // Missing, expired, or otherwise invalid — all treated the same: fall through and mint fresh.
            }
        }
        return this.mint(req, res);
    }

    /**
     * No synchronous token-minting path exists (`JWTUtils` only exposes an async `createToken`) — this path
     * (WebSocket pre-upgrade auth) can only verify a cookie a prior request already set, not mint a new one.
     * Not a real gap in practice: a WebSocket connection only ever opens after the page itself has already
     * loaded once over plain HTTP, by which point `authenticate()` above has already minted and set it.
     */
    public authenticateSync(req: HttpRequest, _res?: HttpResponse): AuthResult | undefined {
        const token: string | undefined = req.cookies?.[COOKIE_NAME];
        if (!token) {
            return undefined;
        }
        try {
            // See authenticate()'s identical comment: a non-throwing decode always has a usable `.profile`.
            const payload: JWTPayload = JWTUtils.decodeTokenSync(this.authConfig, token);
            return { data: token, method: this.name, payload, user: payload.profile as JWTUser };
        } catch {
            return undefined;
        }
    }
}
