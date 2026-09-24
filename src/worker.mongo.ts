///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { register } from "module";
// See server.ts's identical registration for the full rationale (reactDedupeHooks.ts's own doc
// comment has the complete explanation of why this is necessary and why `--preserve-symlinks`
// does not substitute for it).
register(import.meta.url.endsWith(".ts") ? "./lib/reactDedupeHooks.ts" : "./lib/reactDedupeHooks.js", import.meta.url);
import config from "./config.mongo.js";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { Logger } from "@rapidrest/core";
import { ObjectFactory, Server } from "@rapidrest/service-core";
import { MongoTextSearchProvider } from "@rapidmx/restapi/search";
import {
    configureDevAutoProvisioningIfApplicable,
    enableDevAutoLoginIfApplicable,
    mountDevImpersonationRouteIfApplicable,
} from "./dev/enableDevAutoLogin.js";
import { DevLocalDeliveryTransportMongo } from "./dev/DevLocalDeliveryTransportMongo.js";
import { registerCoreProviders } from "./lib/registerCoreProviders.js";
import { enableBasicAuthIfApplicable } from "./lib/enableBasicAuth.js";

import * as fs from "fs";
import { readFile } from "fs/promises";
import { assertProductionSecretsAreSet, DEVELOPMENT_ENVIRONMENTS, trustedAuthservIdWarning } from "./config.defaults.js";
import { configMs, DEFAULT_RELEASE_TIMEOUT_MS, drainAndStop, withTimeout } from "./lib/gracefulShutdown.js";
import { startTelemetryToken } from "./lib/telemetryToken.js";
import { PluginMongo, MailboxMongo } from "@rapidmx/restapi/mongo";
import { PluginHost } from "./plugins/PluginHost.js";
import { MONGO_PLUGIN_PURGE, MONGO_PLUGIN_UI_HOSTS } from "./plugins/hosts/mongo.js";
import { notifyListening, restartWorker } from "./plugins/supervisor.js";

const _filename = fileURLToPath(import.meta.url);
const _dirname = dirname(_filename);

const environment: string = process.env.NODE_ENV || "production";

// The raw NODE_ENV: only an explicit dev/development allows the checked-in development secrets - see
// SECRETS_GUARD_SKIP_ENVIRONMENTS's own doc comment for why `test` does not.
assertProductionSecretsAreSet(config, process.env.NODE_ENV);

const logLevel: string = config.get("logger:level") || (environment === "production" ? "info" : "debug");
const logger = Logger(logLevel, config.get("logger:file"));
// One line while mail:security:trusted_authserv_id is empty, naming the mail features that are off until it's set.
const authservIdWarning: string | undefined = trustedAuthservIdWarning(config);
if (authservIdWarning) {
    logger.warn(authservIdWarning);
}
console.log("Log Level=" + logLevel);

const objectFactory = new ObjectFactory(config, logger);

// @rapidmx/restapi's routes/jobs pull these via string-token @Inject(...) — they only resolve once
// something has explicitly registered a concrete implementation under that exact token (there is no
// config-driven auto-wiring for these). See @rapidmx/restapi's own README ("Usage") and .claude/NOTES.md.
// Shared with worker.ts/worker.sql.ts by registerCoreProviders() (src/lib/registerCoreProviders.ts) so a
// newly-introduced token only ever needs to be added in one place - see that function's own doc comment for the
// two past incidents (missing NodeDnsResolver, then missing EncryptionCertificateAuthority/
// SigningCertificateEnrollment) this exists to prevent.
//
// AcmeEnrollmentDriverJobMongo (src/mongo/Jobs.ts) is registered unconditionally regardless of the
// mail:pki:signing_enrollment:backend setting registerCoreProviders() reads, not because it's a full no-op under
// "manual": only its driveEnrollments() half feature-detects the injected SigningCertificateEnrollment and no-ops
// without rfc8823. Its other half, flagExpiringSigningCerts(), runs unconditionally on every tick regardless of
// backend - an unfiltered scan of every mailbox, writing a SIGNING_CERT_EXPIRING audit entry for any with a
// near-expiry signing key - so re-exporting this job is a real new periodic DB-scan + audit-log-write cost for
// every deployment upgrading through this batch, not just rfc8823 ones. Confirmed intentional on restapi's side
// (flagging an expiring signing key is useful under "manual" too, since nothing else would notice), so left as-is
// rather than gated - just don't assume it's inert.
registerCoreProviders(objectFactory, config, {
    searchProvider: MongoTextSearchProvider,
    devDeliveryTransport: DevLocalDeliveryTransportMongo,
    environment: process.env.NODE_ENV,
});

let server: any = undefined;
let pluginHost: PluginHost | undefined = undefined;
let telemetry: { stop: () => void } | undefined = undefined;

const start = async function (config: any, logger: any) {
    // Load the release notes file
    let releaseNotes: string | undefined = undefined;
    try {
        if (fs.existsSync(`${_dirname}/../RELEASE_NOTES.rst`)) {
            releaseNotes = await readFile(`${_dirname}/../RELEASE_NOTES.rst`, { encoding: "utf-8" });
        }
    } catch (err) {
        logger.debug(err);
    }

    // Initialize EventUtils to be able to send out telemetry events, with a short-lived token that carries no trusted
    // roles and is renewed while the server runs - see lib/telemetryToken.ts.
    telemetry = await startTelemetryToken(config, logger);

    // DEV-ONLY (see enableDevAutoLogin.ts) — both a no-op outside of `yarn dev`.
    await enableDevAutoLoginIfApplicable(objectFactory, logger);
    // Outlook and ActiveSync sign in with HTTP Basic (an app password), checked by auth-server - see lib/BasicAuthJWTStrategy.ts.
    await enableBasicAuthIfApplicable(objectFactory, config, logger, MailboxMongo);
    configureDevAutoProvisioningIfApplicable(config, logger);

    // Create and start the server
    // Install and load this deployment's plugins before the server scans for classes - see plugins/PluginHost.ts.
    pluginHost = await PluginHost.prepare({ config, logger, datastore: "mongo", pluginClass: PluginMongo, appRoot: process.cwd(), uiHosts: MONGO_PLUGIN_UI_HOSTS, purge: MONGO_PLUGIN_PURGE });
    server = new Server({ config, basePath: config.get("base_path"), logger, objectFactory, classLoader: pluginHost.classLoader });
    await server.start();
    notifyListening();
    await pluginHost.start(objectFactory, restartForPlugins);

    // DEV-ONLY (see enableDevAutoLogin.ts) — a no-op outside of `yarn dev`.
    await mountDevImpersonationRouteIfApplicable(server, objectFactory, logger);
};

void start(config, logger);

// Shared by a plugin restart and a shutdown signal arriving meanwhile, so the server is only stopped once.
let stopping: Promise<void> | undefined;
const stopServer = (): Promise<void> =>
    (stopping ??= (async () => {
        // Bounded like shutdown's own release below: with Redis down this would otherwise use up the whole stop timeout.
        await withTimeout(pluginHost?.stop() ?? Promise.resolve(), DEFAULT_RELEASE_TIMEOUT_MS);
        if (server) {
            await server.stop();
        }
        if (objectFactory) {
            await objectFactory.destroy();
        }
    })());

let shuttingDown: boolean = false;
const shutdown = async (signal: string) => {
    if (shuttingDown) {
        return;
    }
    shuttingDown = true;
    logger.info(`Shutting down (${signal})...`);
    telemetry?.stop();
    // SIGTERM is a container/pod stop: report not ready and let in-flight requests finish before stopping. An
    // interactive Ctrl+C (SIGINT), a vanished supervisor, or a development reload (tsx --watch) stops right away.
    const drain: boolean = signal === "SIGTERM" && !DEVELOPMENT_ENVIRONMENTS.includes(process.env.NODE_ENV ?? "");
    const result = await drainAndStop(stopServer, {
        // Gives back the plugin restart lock even if this copy was part-way through a plugin restart, which then stops.
        release: async () => await pluginHost?.stop({ shutdown: true }),
        drainDelayMs: drain ? configMs(config.get("shutdown:drain_delay_ms"), 5_000) : 0,
        timeoutMs: configMs(config.get("shutdown:timeout_ms"), 25_000),
        logger,
    });
    process.exit(result === "stopped" ? 0 : 1);
};

// The plugin set changed: stop cleanly and ask the supervisor (server.mongo.ts) for a fresh process.
// Exits even if stopping fails or hangs, so the process is never left running without its plugin watcher.
const restartForPlugins = () => restartWorker(stopServer, { logger });

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
// The supervisor went away - don't linger as an orphan.
process.on("disconnect", () => void shutdown("disconnect"));
