///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { Server, type ServerOptions } from "@rapidrest/service-core";

/**
 * The server, doing its installation's work (`prepareInstallation()`: the Integrations an administrator chose applied to the configuration, then
 * `seedInstallation()`: the DNS provider config the installer created, the domains it was installed for) in the step `Server.start()` leaves between
 * "the datastores are connected and the routes are registered" and "listen". Nothing is served, and the readiness probe (`GET /api/status`) can't pass, until
 * it has run, so a deployment installed for a domain answers its first request with that domain in place (restapi spec 12.1: "before it reports ready"), and
 * with the DNS resolver, signing CA and other choices of the administrator's Integrations rather than the deployment's.
 *
 * The work must be idempotent: it runs on every start of every server copy. It must not throw, and if it does anyway that is logged and the server starts.
 */
export class InstallationServer extends Server {
    /**
     * @param options The server's options.
     * @param beforeListening The work to do after the datastores are connected and before the server listens.
     */
    constructor(
        options: ServerOptions,
        private readonly beforeListening: () => Promise<unknown>,
    ) {
        super(options);
    }

    protected override async postStart(): Promise<void> {
        await super.postStart();
        try {
            await this.beforeListening();
        } catch (err: any) {
            this.logger.error(`The installation's work before the server listens failed, so the server starts without it: ${err?.message}`);
        }
    }
}
