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
import {
    FsDkimKeyProvider,
    LocalFsBlobStore,
    LocalX509CertificateAuthority,
    ManualSigningCertificateEnrollment,
    NodeDnsResolver,
    OpenBaoPkiCertificateAuthority,
    Rfc8823AcmeSigningCertificateEnrollment,
    S3BlobStore,
} from "@rapidmx/restapi";
import { MongoTextSearchProvider } from "@rapidmx/restapi/search";
import {
    configureDevAutoProvisioningIfApplicable,
    enableDevAutoLoginIfApplicable,
    mountDevImpersonationRouteIfApplicable,
} from "./dev/enableDevAutoLogin.js";
import { DevLocalDeliveryTransportMongo } from "./dev/DevLocalDeliveryTransportMongo.js";
import { registerMailProviders } from "./dev/registerMailProviders.js";
import { DohDnssecDnsResolver } from "./dns/DohDnssecDnsResolver.js";
import { selectConfigDrivenBackend } from "./lib/configDrivenBackend.js";

import * as fs from "fs";
import { readFile } from "fs/promises";
import * as path from "path";
import { assertProductionSecretsAreSet, DEVELOPMENT_ENVIRONMENTS, trustedAuthservIdWarning } from "./config.defaults.js";
import { configMs, DEFAULT_RELEASE_TIMEOUT_MS, drainAndStop, withTimeout } from "./lib/gracefulShutdown.js";
import { startTelemetryToken } from "./lib/telemetryToken.js";
import { PluginMongo } from "@rapidmx/restapi/mongo";
import { PluginHost } from "./plugins/PluginHost.js";
import { MONGO_PLUGIN_UI_HOSTS } from "./plugins/hosts/mongo.js";
import { notifyListening, restartWorker } from "./plugins/supervisor.js";
import { TieredRateLimiter } from "./lib/TieredRateLimiter.js";

const _filename = fileURLToPath(import.meta.url);
const _dirname = dirname(_filename);

const environment: string = process.env.NODE_ENV || "production";

// The raw NODE_ENV: only an explicit dev/development/test allows the checked-in development secrets.
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

// Separate anonymous and signed-in rate limits (config `rateLimit` and `rateLimit.authenticated`) - see TieredRateLimiter.ts.
objectFactory.register(TieredRateLimiter, "RateLimiter");

// @rapidmx/restapi's routes/jobs pull these via string-token @Inject(...) — they only resolve once
// something has explicitly registered a concrete implementation under that exact token (there is no
// config-driven auto-wiring for these). See @rapidmx/restapi's own README ("Usage") and .claude/NOTES.md.
// BlobStore backend is config-driven (mail:blob:backend) rather than hardcoded, same pattern as
// mail:pki:backend below: `"local"` (default) needs only `mail:blob:local:root`; `"s3"` delegates to an
// S3-compatible bucket (mail:blob:s3:*) for production use - see config.mongo.ts for the full key list.
objectFactory.register(selectConfigDrivenBackend(config, "mail:blob:backend", "s3", LocalFsBlobStore, S3BlobStore), "BlobStore");
objectFactory.register(MongoTextSearchProvider, "SearchProvider");
// SpamScanProvider/AvScanProvider/MailTransport: rspamd, ClamAV and Postfix. Under a development NODE_ENV only, wrapped so
// `yarn dev` can send mail without them running - see dev/registerMailProviders.ts. Any other NODE_ENV fails closed.
registerMailProviders(objectFactory, DevLocalDeliveryTransportMongo, process.env.NODE_ENV);
// DnsResolver backend is config-driven (mail:dns:resolver) rather than hardcoded, same rationale as
// mail:pki:backend below: `"node"` (default) is Node's own built-in resolver with no DNSSEC validation,
// `"doh-dnssec"` validates DNSSEC (specs/end-to-end_encryption.md's Transport Trust requirement) via a
// trusted upstream DoH resolver (mail:dns:doh:*) instead - see DohDnssecDnsResolver.ts's own doc comment
// for why Node's built-in resolver can't do this itself.
const dnsResolverBackend: string = config.get("mail:dns:resolver") || "node";
objectFactory.register(dnsResolverBackend === "doh-dnssec" ? DohDnssecDnsResolver : NodeDnsResolver, "DnsResolver");
// Opts into automatic per-domain DKIM key generation (writing into the shared volume the Postfix/rspamd
// container reads from - see docker-compose.mail.yml's `dkim_rspamd_keys` volume and `mail:dkim:*`
// config) rather than the library's default manual model (`NullDkimKeyProvider`, an admin fills in
// dkimSelector/dkimPublicKey by hand). See @rapidmx/restapi's dkim/DkimKeyProvider.ts doc comment for the
// security tradeoff this represents before changing it back.
objectFactory.register(FsDkimKeyProvider, "DkimKeyProvider");
// EncryptionCertificateAuthority backend is config-driven (mail:pki:backend) rather than hardcoded like
// every provider above, since an admin needs to pick this per-deployment without a code change: `"local"`
// (default) is zero-infra (LocalX509CertificateAuthority persists its CA key/cert to mail:pki:local_ca:dir),
// `"openbao"` delegates to a self-hosted OpenBao/Vault PKI mount (mail:pki:openbao:*) for production use.
// See config.mongo.ts for the full key list and .claude/NOTES.md for why this one provider breaks from the
// rest of this file's hardcoded-per-file convention.
const caBackend: string = config.get("mail:pki:backend") || "local";
objectFactory.register(
    caBackend === "openbao" ? OpenBaoPkiCertificateAuthority : LocalX509CertificateAuthority,
    "EncryptionCertificateAuthority"
);
// SigningCertificateEnrollment backend is config-driven (mail:pki:signing_enrollment:backend) rather
// than hardcoded, same pattern as mail:pki:backend above: `"manual"` (default) is the CA-agnostic,
// human-in-the-loop flow (mail:pki:manual_enrollment:store_path); `"rfc8823"` automates public-CA
// enrollment end to end via RFC 8823 email-reply-00 ACME (mail:pki:rfc8823:*) - see config.mongo.ts for
// the full key list. AcmeEnrollmentDriverJobMongo (src/mongo/Jobs.ts) is registered unconditionally
// regardless of this setting, not because it's a full no-op under "manual": only its
// driveEnrollments() half feature-detects the injected SigningCertificateEnrollment and no-ops without
// rfc8823. Its other half, flagExpiringSigningCerts(), runs unconditionally on every tick regardless of
// backend - an unfiltered scan of every mailbox, writing a SIGNING_CERT_EXPIRING audit entry for any
// with a near-expiry signing key - so re-exporting this job is a real new periodic DB-scan + audit-log-
// write cost for every deployment upgrading through this batch, not just rfc8823 ones. Confirmed
// intentional on restapi's side (flagging an expiring signing key is useful under "manual" too, since
// nothing else would notice), so left as-is rather than gated - just don't assume it's inert.
objectFactory.register(
    selectConfigDrivenBackend(
        config,
        "mail:pki:signing_enrollment:backend",
        "rfc8823",
        ManualSigningCertificateEnrollment,
        Rfc8823AcmeSigningCertificateEnrollment,
    ),
    "SigningCertificateEnrollment"
);

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
    configureDevAutoProvisioningIfApplicable(config, logger);

    // Create and start the server
    // Install and load this deployment's plugins before the server scans for classes - see plugins/PluginHost.ts.
    pluginHost = await PluginHost.prepare({ config, logger, datastore: "mongo", pluginClass: PluginMongo, appRoot: process.cwd(), uiHosts: MONGO_PLUGIN_UI_HOSTS });
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
