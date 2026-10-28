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
import { ObjectFactory } from "@rapidrest/service-core";
import { MongoTextSearchProvider } from "@rapidmx/restapi/search";
import {
    configureDevAutoProvisioningIfApplicable,
    enableDevAutoLoginIfApplicable,
    mountDevImpersonationRouteIfApplicable,
} from "./dev/enableDevAutoLogin.js";
import { DevLocalDeliveryTransportMongo } from "./dev/DevLocalDeliveryTransportMongo.js";
import { registerCoreProviders } from "./lib/registerCoreProviders.js";
import { enableBasicAuthIfApplicable } from "./lib/enableBasicAuth.js";
import { assertConfigKeyringIsSet, createPluginHostCipher, ensureDevelopmentKeyring, startConfigEncryption, type ConfigEncryptionRuntime } from "./lib/configEncryption.js";
import { startDnsPublishing } from "./dns/AutodiscoverAnnouncement.js";
import { InstallationServer } from "./lib/InstallationServer.js";
import { seedInstallation } from "./lib/seedInstallation.js";
import { MONGO_INSTALLATION } from "./lib/installation/mongo.js";
import { prepareIntegrations, startIntegrationsSync, type PreparedIntegrations, type RunningIntegrationsSync } from "./integrations/startIntegrations.js";

import * as fs from "fs";
import { readFile } from "fs/promises";
import { assertProductionSecretsAreSet, DEVELOPMENT_ENVIRONMENTS, escrowAuditKeyWarning, trustedAuthservIdWarning, weakIngestSecretWarning } from "./config.defaults.js";
import { configMs, DEFAULT_RELEASE_TIMEOUT_MS, drainAndStop, withTimeout } from "./lib/gracefulShutdown.js";
import { startTelemetryToken } from "./lib/telemetryToken.js";
import { ConfigKeyStateMongo, IntegrationSettingsMongo, MailboxMongo, PluginMongo, PluginSecretEncryptorMongo } from "@rapidmx/restapi/mongo";
import { PluginHost } from "./plugins/PluginHost.js";
import { TrackedConfigCipherMongo } from "./secrets/TrackedConfigCipherMongo.js";
import { MONGO_PLUGIN_PURGE, MONGO_PLUGIN_UI_HOSTS } from "./plugins/hosts/mongo.js";
import { notifyListening, restartWorker } from "./plugins/supervisor.js";

const _filename = fileURLToPath(import.meta.url);
const _dirname = dirname(_filename);

const environment: string = process.env.NODE_ENV || "production";

// The raw NODE_ENV: only an explicit dev/development allows the checked-in development secrets - see
// SECRETS_GUARD_SKIP_ENVIRONMENTS's own doc comment for why `test` does not.
assertProductionSecretsAreSet(config, process.env.NODE_ENV);
// Likewise a production server refuses to start without the keyring the credentials, API keys and tokens saved in the admin console are encrypted with.
assertConfigKeyringIsSet(config, process.env.NODE_ENV);

const logLevel: string = config.get("logger:level") || (environment === "production" ? "info" : "debug");
const logger = Logger(logLevel, config.get("logger:file"));
// One line while mail:security:trusted_authserv_id is empty, naming the mail features that are off until it's set.
const authservIdWarning: string | undefined = trustedAuthservIdWarning(config);
if (authservIdWarning) {
    logger.warn(authservIdWarning);
}
// An empty mail:escrow:audit_hmac_key leaves the escrow audit log's hash chain unkeyed, so it can be rewritten undetected.
const escrowKeyWarning: string | undefined = escrowAuditKeyWarning(config, process.env.NODE_ENV);
if (escrowKeyWarning) {
    logger.error(escrowKeyWarning);
}
const weakSecretWarning: string | undefined = weakIngestSecretWarning(config, process.env.NODE_ENV);
if (weakSecretWarning) {
    logger.error(weakSecretWarning);
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
    configCipher: TrackedConfigCipherMongo,
    devDeliveryTransport: DevLocalDeliveryTransportMongo,
    environment: process.env.NODE_ENV,
});

let server: any = undefined;
let pluginHost: PluginHost | undefined = undefined;
let telemetry: { stop: () => void } | undefined = undefined;
let configEncryption: ConfigEncryptionRuntime | undefined = undefined;
let integrations: PreparedIntegrations | undefined = undefined;
let integrationsSync: RunningIntegrationsSync | undefined = undefined;

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

    // Under `yarn dev` only: the keyring that encrypts the configuration secrets, generated into data/ on first use - see lib/configEncryption.ts.
    await ensureDevelopmentKeyring(config, process.env.NODE_ENV, logger);

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
    // What an administrator set in the console's Integrations is a configuration layer, and HostConfig reads the configuration at use time: both are in place
    // before any plugin loads (the layer stays empty until the datastores are connected, so the plugin host installs from the deployment's registry) - see
    // integrations/startIntegrations.ts.
    const hostCipher = await createPluginHostCipher(objectFactory);
    integrations = prepareIntegrations(config, hostCipher, logger);
    pluginHost = await PluginHost.prepare({ config, logger, datastore: "mongo", pluginClass: PluginMongo, configKeyStateClass: ConfigKeyStateMongo, cipher: hostCipher, appRoot: process.cwd(), uiHosts: MONGO_PLUGIN_UI_HOSTS, purge: MONGO_PLUGIN_PURGE });
    // The installation's own setup (the DNS provider config the installer created, the domains it was installed for) runs once the datastores are connected and before the
    // server listens, so the readiness probe passes only after it - see lib/InstallationServer.ts and lib/seedInstallation.ts.
    server = new InstallationServer({ config, basePath: config.get("base_path"), logger, objectFactory, classLoader: pluginHost.classLoader }, () =>
        seedInstallation(objectFactory, config, logger, MONGO_INSTALLATION),
    );
    await server.start();
    notifyListening();
    await pluginHost.start(objectFactory, restartForPlugins);

    // The datastores are connected: report the keys this copy has loaded to the others, and encrypt the plugin secret settings once the rollout is done.
    // Both run in the background and neither can stop the server.
    configEncryption = await startConfigEncryption(objectFactory, PluginSecretEncryptorMongo, logger);

    // The datastores are connected: follow the Integrations row from here on (the change notice, and its version on a timer), so a change made in the admin
    // console applies in this copy without a restart. Not stoppable by a failure; see integrations/startIntegrations.ts.
    integrationsSync = await startIntegrationsSync(objectFactory, integrations.layer, IntegrationSettingsMongo, logger);

    // The plugins are loaded, so this copy knows whether the Autodiscover plugin runs: tell the DNS controller when that changed its records. Not awaited: it
    // waits on Redis and cannot stop the server from starting.
    void startDnsPublishing(objectFactory, config, logger);

    // DEV-ONLY (see enableDevAutoLogin.ts) — a no-op outside of `yarn dev`.
    await mountDevImpersonationRouteIfApplicable(server, objectFactory, logger);
};

void start(config, logger);

// Shared by a plugin restart and a shutdown signal arriving meanwhile, so the server is only stopped once.
let stopping: Promise<void> | undefined;
const stopServer = (): Promise<void> =>
    (stopping ??= (async () => {
        await withTimeout(integrationsSync?.stop() ?? Promise.resolve(), DEFAULT_RELEASE_TIMEOUT_MS);
        await withTimeout(configEncryption?.stop() ?? Promise.resolve(), DEFAULT_RELEASE_TIMEOUT_MS);
        // Bounded like shutdown's own release below: with Redis down this would otherwise use up the whole stop timeout.
        await withTimeout(pluginHost?.stop() ?? Promise.resolve(), DEFAULT_RELEASE_TIMEOUT_MS);
        if (server) {
            await server.stop();
        }
        if (objectFactory) {
            await objectFactory.destroy();
        }
        integrations?.stop();
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
