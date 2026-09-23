///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * DEV-ONLY. Never mounted outside of `yarn dev` — see `enableDevAutoLogin.ts`'s
 * `mountDevImpersonationRouteIfApplicable()`, the sole place this class is ever instantiated and registered
 * (deliberately not placed under `src/mongo/routes/`/`src/sql/routes/`, so the normal `ClassLoader`
 * directory scan that auto-mounts every other route never even discovers this file).
 *
 * Mirrors `@rapidrest/auth`'s real `BaseImpersonationRoute` contract closely enough that the admin console's
 * "Access this mailbox" button and the webmail client's impersonation banner (see
 * `@rapidmx/react-shared`'s `mailApi.ts`) work identically against `yarn dev`, without a real auth-server running:
 * `POST /impersonate` / `POST /impersonate/stop`, the same `jwt`/`jwt_impersonator` cookie names and shape.
 *
 * Unlike the real auth-server endpoint, this can't look up a target user's real roles/scopes — mail-server
 * has no local user directory of its own (identity lives entirely in auth-server's own database, which
 * `yarn dev` deliberately runs without). It mints a plain, unprivileged token (`roles: [], scopes: []`) for
 * the target uid instead — a reasonable dev approximation, since a mailbox owner is ordinarily a regular
 * user, not a trusted-role caller.
 *
 * @author Jean-Philippe Steinmetz
 */
import { ApiError, JWTUtils, ObjectDecorators, type JWTUser, type JWTUtilsConfig } from "@rapidrest/core";
import { ApiErrorMessages, ApiErrors, RouteDecorators, type HttpRequest, type HttpResponse } from "@rapidrest/service-core";

const { Config, Logger } = ObjectDecorators;
const { ApiRoute, Auth, Post, Request, Response } = RouteDecorators;
const AuthUser = RouteDecorators.User;

/** Matches `JWTStrategyOptions.cookieName`'s hardcoded default — see `DevAutoAuthStrategy.ts`. */
const SESSION_COOKIE_NAME = "jwt";

/** Holds the impersonator's own session token while they're viewing as someone else. */
const IMPERSONATOR_COOKIE_NAME = "jwt_impersonator";

export interface ImpersonateInput {
    userUid: string;
}

@ApiRoute("admin")
export class DevImpersonationRoute {
    @Config("auth")
    private authConfig?: JWTUtilsConfig;

    @Logger
    private logger: any;

    /** See `DevAutoAuthStrategy.setCookie()`'s identical doc comment — no `Secure`, dev is always plain HTTP. */
    private buildCookie(name: string, token: string): string {
        return `${name}=${token}; Path=/; SameSite=Lax`;
    }

    private buildClearCookie(name: string): string {
        return `${name}=; Path=/; Max-Age=0; SameSite=Lax`;
    }

    /**
     * Deliberately synchronous (`JWTUtils.createTokenSync`, not the async `createToken`) — see
     * `DevAutoAuthStrategy.mint()`'s identical doc comment on why a `Set-Cookie` after an `await` reproducibly
     * crashes uWebSockets.js.
     */
    @Auth(["jwt"])
    @Post("/impersonate")
    public impersonate(
        body: ImpersonateInput,
        @Request req: HttpRequest,
        @Response res: HttpResponse,
        @AuthUser user?: JWTUser,
    ): { token: string; user: JWTUser } {
        if (!body?.userUid) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, ApiErrorMessages.INVALID_REQUEST);
        }
        if (!this.authConfig) {
            throw new ApiError(ApiErrors.INTERNAL_ERROR, 500, ApiErrorMessages.INTERNAL_ERROR);
        }

        const currentToken: string | undefined = req.cookies?.[SESSION_COOKIE_NAME];
        if (currentToken) {
            res.appendHeader("Set-Cookie", this.buildCookie(IMPERSONATOR_COOKIE_NAME, currentToken));
        }

        const impersonated: JWTUser = { uid: body.userUid, roles: [], scopes: [] };
        const token: string = JWTUtils.createTokenSync(this.authConfig, impersonated);
        res.appendHeader("Set-Cookie", this.buildCookie(SESSION_COOKIE_NAME, token));

        this.logger?.warn(
            `[DevImpersonationRoute] '${user?.uid ?? "unknown"}' started impersonating '${body.userUid}'. ` +
                `yarn dev only; never active in production.`,
        );

        return { token, user: impersonated };
    }

    @Auth(["jwt"])
    // POST, not GET: mirrors the real BaseImpersonationRoute — a state-changing GET is exploitable via a
    // bare navigation, bypassing CSRF defenses entirely (see that route's own doc comment).
    @Post("/impersonate/stop")
    public stopImpersonating(
        @Request req: HttpRequest,
        @Response res: HttpResponse,
        @AuthUser user?: JWTUser,
    ): { restored: boolean } {
        const impersonatorToken: string | undefined = req.cookies?.[IMPERSONATOR_COOKIE_NAME];
        if (!impersonatorToken) {
            return { restored: false };
        }

        res.appendHeader("Set-Cookie", this.buildCookie(SESSION_COOKIE_NAME, impersonatorToken));
        res.appendHeader("Set-Cookie", this.buildClearCookie(IMPERSONATOR_COOKIE_NAME));

        this.logger?.warn(
            `[DevImpersonationRoute] Stopped impersonating (was acting as '${user?.uid}'). yarn dev only.`,
        );

        return { restored: true };
    }
}
