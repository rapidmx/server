///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { AuthMiddleware, RouteUtils, type ObjectFactory, type Server } from "@rapidrest/service-core";
import { DevAutoAuthStrategy } from "./DevAutoAuthStrategy.js";
import { DevImpersonationRoute } from "./DevImpersonationRoute.js";

/** The username auto-provisioning offers the dev user under `yarn dev` (its mailbox is `dev-user@example.com`). */
export const DEV_USER_ALIAS = "dev-user";

/**
 * `true` only when this process is `tsx --watch src/server*.ts` — i.e. `yarn dev`/`rapidrest dev` — never a
 * compiled `dist/**\/*.js` run (production) and never a test runner. Mirrors `@rapidrest/react`'s own
 * `hasTsxContext` detection in `ReactRoute.resolveAppFile()` (same signal, same reasoning, already proven to
 * correctly distinguish tsx-run source from compiled output in this exact project): a `.ts`-suffixed entry
 * point is only ever tsx running real source, and the `NODE_ENV`/`VITEST`/`JEST_WORKER_ID` checks rule out
 * the ambiguous cases a bare extension check alone can't (a misconfigured `NODE_ENV` on a real deployment
 * that somehow still ran from `.ts`, or a test runner that happens to import this module).
 */
export function isRunningUnderYarnDev(): boolean {
    return (
        process.env.NODE_ENV !== "production" &&
        !process.env.VITEST &&
        !process.env.JEST_WORKER_ID &&
        (process.argv[1]?.endsWith(".ts") ?? false)
    );
}

/**
 * DEV-ONLY: makes every request auto-authenticate as a synthetic local user (see
 * `DevAutoAuthStrategy`'s own doc comment), so the webmail/admin UIs work end-to-end against
 * `yarn dev` without a real `auth-server` deployment running alongside this service. Call this
 * once, immediately before `server.start()` — only from `server.ts`/`server.mongo.ts`/
 * `server.sql.ts`, never from a test file building its own `Server` (those must keep exercising
 * real, unmodified auth).
 *
 * Overrides whatever is registered under the `"jwt"` strategy name (normally the real
 * `JWTStrategy`, per `auth:strategy` config) — safe because `DevAutoAuthStrategy` itself still
 * honors a real, already-valid `jwt` cookie unchanged, only minting a synthetic one when none is
 * present or it fails to verify. A no-op whenever `isRunningUnderYarnDev()` is `false`.
 */
export async function enableDevAutoLoginIfApplicable(objectFactory: ObjectFactory, logger: any): Promise<void> {
    if (!isRunningUnderYarnDev()) {
        return;
    }

    logger.warn(
        "[dev] Auto-login is active — every request will be auto-authenticated as a synthetic local user. " +
            "This ONLY happens under `yarn dev` and is never a substitute for the real auth-server anywhere else.",
    );

    const authMiddleware = await objectFactory.newInstance<AuthMiddleware>(AuthMiddleware);
    const devStrategy = await objectFactory.newInstance<DevAutoAuthStrategy>(DevAutoAuthStrategy);
    authMiddleware.register("jwt", devStrategy);
}

/**
 * DEV-ONLY: mounts a local `/api/admin/impersonate` + `/api/admin/impersonate/stop` pair (see
 * `DevImpersonationRoute`'s own doc comment) so the admin console's "Access this mailbox" button and the
 * webmail client's "stop impersonating" banner both work against `yarn dev` without a real auth-server
 * running — production always calls the real auth-server for this instead (see
 * `@rapidmx/react-shared`'s `mailApi.ts`).
 *
 * Unlike `enableDevAutoLoginIfApplicable()` (which registers an auth *strategy* before `server.start()`),
 * mounting a *route* needs a real `Server` instance to attach to — call this once, immediately after
 * `await server.start()`. `DevImpersonationRoute` is never imported/instantiated at all when
 * `isRunningUnderYarnDev()` is `false`, so — unlike a route that's merely gated at request time — it is
 * never even registered outside of `yarn dev`, matching every other dev-only exception in this codebase.
 */
export async function mountDevImpersonationRouteIfApplicable(
    server: Server,
    objectFactory: ObjectFactory,
    logger: any,
): Promise<void> {
    if (!isRunningUnderYarnDev()) {
        return;
    }

    const routeUtils = await objectFactory.newInstance<RouteUtils>(RouteUtils);
    const route = await objectFactory.newInstance<DevImpersonationRoute>(DevImpersonationRoute);
    await routeUtils.registerRoute(server.getApplication(), route);

    logger.warn(
        "[dev] Mounted a local dev-only impersonation endpoint (POST/GET /api/admin/impersonate[/stop]) so " +
            "'Access this mailbox' works without a real auth-server running. yarn dev only.",
    );
}

/**
 * DEV-ONLY: turns on `@rapidmx/restapi`'s self-service mailbox auto-provisioning
 * (`BaseMailboxRoute.autoProvision()`) with a placeholder domain and a static alias list, so it's
 * exercisable against `yarn dev` out of the box with no real auth-server running. Call this once, before
 * `new Server(...)` — the config values it sets must already be in place by the time routes are
 * constructed and their `@Config` fields resolved.
 *
 * Uses `mail:auto_provision:static_aliases` rather than pointing `mail:auth_server_url` at this same
 * process: a Node `fetch()` back to this server's own listening address, issued from inside a request
 * handler already running on it, is refused at the TCP level (confirmed directly — the underlying
 * uWebSockets.js server doesn't accept a new self-connection while still mid-request), so a real
 * self-referencing HTTP round-trip can't work here regardless of what it points at. The alias list is
 * the dev user's username (`DEV_USER_ALIAS`): auto-provisioning offers `dev-user@example.com` to whoever
 * asks, which under `yarn dev` is `DevAutoAuthStrategy`'s synthetic user (uid `DEV_USER_UID`). It's a
 * name, not the uid - uids are UUIDs (restapi only grants mailbox access to UUID-shaped uids).
 *
 * Only fills in a value that isn't already explicitly configured (checked via a plain `config.get()`,
 * not `@Config`'s own decorator — that only supplies a fallback at the read site, it never writes the
 * default back into the shared config store), so an admin who already set `mail:auto_provision:*`/
 * `mail:domains` themselves (e.g. to point at a real auth-server they're running locally for a fuller
 * integration test) keeps exactly what they configured — this only fills the gaps.
 */
export function configureDevAutoProvisioningIfApplicable(config: any, logger: any): void {
    if (!isRunningUnderYarnDev()) {
        return;
    }

    let configured = false;
    if (config.get("mail:auto_provision:enabled") === undefined) {
        config.set("mail:auto_provision:enabled", true);
        configured = true;
    }
    if (!(config.get("mail:domains")?.length > 0)) {
        config.set("mail:domains", ["example.com"]);
        configured = true;
    }
    if (!(config.get("mail:auto_provision:static_aliases")?.length > 0)) {
        config.set("mail:auto_provision:static_aliases", [DEV_USER_ALIAS]);
        configured = true;
    }

    if (configured) {
        logger.warn(
            "[dev] Self-service mailbox auto-provisioning is configured for local testing (domain: " +
                "example.com, static alias list — no real auth-server call). yarn dev only; set " +
                "mail:auto_provision:*/mail:domains yourself to override any of this.",
        );
    }
}
