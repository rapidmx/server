///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { register } from "module";
// Forces every `react`/`react-dom` resolution (from this project's own code AND from the
// `link:`-ed @rapidmx/react-shared / @rapidmx/web-client packages' own SSR'd modules) onto this
// project's single installed copy — see reactDedupeHooks.ts's own doc comment for why this is
// necessary (Vite's `resolve.dedupe` only covers the client bundle, not ReactRoute's plain-Node
// SSR `import()` path) and why `--preserve-symlinks` does not substitute for it. Must run before
// any page/layout module is ever dynamically imported — registering it here, at the top of this
// process's own entry point, guarantees that.
register(import.meta.url.endsWith(".ts") ? "./lib/reactDedupeHooks.ts" : "./lib/reactDedupeHooks.js", import.meta.url);
import config from "./config.js";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { JWTUtils, EventUtils, Logger } from "@rapidrest/core";
import { ObjectFactory, Server } from "@rapidrest/service-core";
import {
    FsDkimKeyProvider,
    LocalFsBlobStore,
    LocalX509CertificateAuthority,
    ManualSigningCertificateEnrollment,
    NodeDnsResolver,
    OpenBaoPkiCertificateAuthority,
    PostfixSendmailTransport,
    Rfc8823AcmeSigningCertificateEnrollment,
    S3BlobStore,
} from "@rapidmx/restapi";
import { MongoTextSearchProvider } from "@rapidmx/restapi/search";
import { ClamAvScanProvider, RspamdSpamScanProvider } from "@rapidmx/restapi/scan";
import {
    configureDevAutoProvisioningIfApplicable,
    enableDevAutoLoginIfApplicable,
    mountDevImpersonationRouteIfApplicable,
} from "./dev/enableDevAutoLogin.js";
import { DohDnssecDnsResolver } from "./dns/DohDnssecDnsResolver.js";
import { selectConfigDrivenBackend } from "./lib/configDrivenBackend.js";

import * as fs from "fs";
import { readFile } from "fs/promises";
import * as os from "os";
import { assertProductionSecretsAreSet } from "./config.defaults.js";
import { PluginMongo } from "@rapidmx/restapi/mongo";
import { PluginHost } from "./plugins/PluginHost.js";
import { notifyListening, restartWorker } from "./plugins/supervisor.js";
import { TieredRateLimiter } from "./lib/TieredRateLimiter.js";

const _filename = fileURLToPath(import.meta.url);
const _dirname = dirname(_filename);

const environment: string = process.env.NODE_ENV || "production";

assertProductionSecretsAreSet(config, environment);

const logLevel: string = config.get("logger:level") || (environment === "production" ? "info" : "debug");
const logger = Logger(logLevel, config.get("logger:file"));
console.log("Log Level=" + logLevel);

const objectFactory = new ObjectFactory(config, logger);

// Separate anonymous and signed-in rate limits (config `rateLimit` and `rateLimit.authenticated`) - see TieredRateLimiter.ts.
objectFactory.register(TieredRateLimiter, "RateLimiter");

// @rapidmx/restapi's routes/jobs pull these via string-token @Inject(...) — they only resolve once
// something has explicitly registered a concrete implementation under that exact token (there is no
// config-driven auto-wiring for these). See @rapidmx/restapi's own README ("Usage") and .claude/NOTES.md.
// Mirrors server.mongo.ts's own registration block (this entry is the same Mongo-backed flavor, just the
// generic `yarn dev` one - see that file's own comments for the full rationale on each config-driven pick).
objectFactory.register(selectConfigDrivenBackend(config, "mail:blob:backend", "s3", LocalFsBlobStore, S3BlobStore), "BlobStore");
objectFactory.register(MongoTextSearchProvider, "SearchProvider");
objectFactory.register(RspamdSpamScanProvider, "SpamScanProvider");
objectFactory.register(ClamAvScanProvider, "AvScanProvider");
objectFactory.register(PostfixSendmailTransport, "MailTransport");
const dnsResolverBackend: string = config.get("mail:dns:resolver") || "node";
objectFactory.register(dnsResolverBackend === "doh-dnssec" ? DohDnssecDnsResolver : NodeDnsResolver, "DnsResolver");
// Opts into automatic per-domain DKIM key generation (writing into the shared volume the Postfix/rspamd
// container reads from - see docker-compose.mail.yml's `dkim_rspamd_keys` volume and `mail:dkim:*`
// config) rather than the library's default manual model (`NullDkimKeyProvider`, an admin fills in
// dkimSelector/dkimPublicKey by hand). See @rapidmx/restapi's dkim/DkimKeyProvider.ts doc comment for the
// security tradeoff this represents before changing it back.
objectFactory.register(FsDkimKeyProvider, "DkimKeyProvider");
// EncryptionCertificateAuthority/SigningCertificateEnrollment: see server.mongo.ts's own comments for the
// full rationale on each config-driven pick. Missing here previously - server.ts (the entry `yarn dev`
// actually runs) was never updated when this PKI/RFC 8823 batch added these to server.mongo.ts/
// server.sql.ts, so any route touching either token (e.g. KeyVaultRoute) failed to construct at all under
// `yarn dev` with "No class found with name: EncryptionCertificateAuthority".
const caBackend: string = config.get("mail:pki:backend") || "local";
objectFactory.register(
    caBackend === "openbao" ? OpenBaoPkiCertificateAuthority : LocalX509CertificateAuthority,
    "EncryptionCertificateAuthority"
);
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

    // Initialize EventUtils to be able to send out telemetry events. Build a standalone copy of the
    // auth config rather than mutating the object `config.get()` returns: nconf does not clone nested
    // values, so `config.get("auth")` returns the exact live object shared by every other consumer of
    // this config (e.g. `TokenUtils`) — deleting `expiresIn` off of it in place previously stripped
    // expiry from every access token the server issues, not just this one telemetry token.
    const configuredAuth: any = config.get("auth");
    const auth: any = { ...configuredAuth, options: { ...configuredAuth.options } };
    delete auth.options.expiresIn;
    const token: string = await JWTUtils.createToken(auth,
        {
            uid: `${config.get("service_name")}-${os.hostname()}`,
            roles: config.get("trusted_roles"),
            scopes: [],
        });
    await EventUtils.init(config, logger, token);

    // DEV-ONLY (see enableDevAutoLogin.ts) — both a no-op outside of `yarn dev`.
    await enableDevAutoLoginIfApplicable(objectFactory, logger);
    configureDevAutoProvisioningIfApplicable(config, logger);

    // Create and start the server
    // Install and load this deployment's plugins before the server scans for classes - see plugins/PluginHost.ts.
    pluginHost = await PluginHost.prepare({ config, logger, datastore: "mongo", pluginClass: PluginMongo, appRoot: process.cwd() });
    server = new Server({ config, basePath: config.get("base_path"), logger, objectFactory, classLoader: pluginHost.classLoader });
    await server.start();
    notifyListening();
    await pluginHost.start(objectFactory, restartForPlugins);

    // DEV-ONLY (see enableDevAutoLogin.ts) — a no-op outside of `yarn dev`.
    await mountDevImpersonationRouteIfApplicable(server, objectFactory, logger);
};

void start(config, logger);

const stopServer = async () => {
    await pluginHost?.stop();
    if (server) {
        await server.stop();
    }
    if (objectFactory) {
        await objectFactory.destroy();
    }
};

const shutdown = async () => {
    logger.info("Shutting down...");
    await stopServer();
    process.exit(0);
};

// The plugin set changed: stop cleanly and ask the supervisor (server.ts) for a fresh process.
// Exits even if stopping fails or hangs, so the process is never left running without its plugin watcher.
const restartForPlugins = () => restartWorker(stopServer, { logger });

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
// The supervisor went away - don't linger as an orphan.
process.on("disconnect", shutdown);
