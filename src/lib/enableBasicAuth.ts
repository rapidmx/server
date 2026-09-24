///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { AuthMiddleware, type ObjectFactory } from "@rapidrest/service-core";
import { isRunningUnderYarnDev } from "../dev/enableDevAutoLogin.js";
import { BasicAuthJWTStrategy } from "./BasicAuthJWTStrategy.js";

/**
 * Lets Outlook's MAPI/HTTP and ActiveSync clients - which can only send HTTP Basic credentials - sign in with a username and an
 * app password (see `BasicAuthJWTStrategy`), by putting that strategy in front of the `jwt` one every route already uses.
 *
 * Call this once, before `new Server(...)` and after the dev auto-login has had its chance (it does nothing under `yarn dev`,
 * which replaces `jwt` with a strategy that authenticates everyone). A no-op when `mail:basic_auth:enabled` is `false`, or
 * when there is no `mail:auth_server_url` to check credentials against.
 *
 * @param config The server's configuration.
 * @param mailboxClass The backend's `Mailbox` model, for resolving a mailbox address to the user it belongs to.
 */
export async function enableBasicAuthIfApplicable(
    objectFactory: ObjectFactory,
    config: { get(key: string): unknown },
    logger: any,
    mailboxClass: any,
): Promise<void> {
    if (isRunningUnderYarnDev() || config.get("mail:basic_auth:enabled") === false) {
        return;
    }
    if (!config.get("mail:auth_server_url")) {
        logger.warn("Basic sign-in (app passwords) for Outlook and ActiveSync is off: mail:auth_server_url is not set.");
        return;
    }

    const authMiddleware = await objectFactory.newInstance<AuthMiddleware>(AuthMiddleware);
    const jwt = authMiddleware.strategies.get("jwt");
    if (!jwt) {
        logger.warn("Basic sign-in (app passwords) is off: no jwt authentication strategy is registered to build on.");
        return;
    }
    const strategy = await objectFactory.newInstance<BasicAuthJWTStrategy>(BasicAuthJWTStrategy, { args: [jwt, objectFactory, mailboxClass] });
    authMiddleware.register("jwt", strategy);
    logger.info("Basic sign-in (app passwords) is on for the paths in mail:basic_auth:paths.");
}
