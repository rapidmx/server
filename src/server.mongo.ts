#!/usr/bin/env node
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
} from "@rapidmx/restapi";
import { MongoTextSearchProvider } from "@rapidmx/restapi/search";
import { ClamAvScanProvider, RspamdSpamScanProvider } from "@rapidmx/restapi/scan";
import {
    configureDevAutoProvisioningIfApplicable,
    enableDevAutoLoginIfApplicable,
    mountDevImpersonationRouteIfApplicable,
} from "./dev/enableDevAutoLogin.js";

import * as fs from "fs";
import { readFile } from "fs/promises";
import * as os from "os";
import * as path from "path";
import { assertProductionSecretsAreSet } from "./config.defaults.js";

const _filename = fileURLToPath(import.meta.url);
const _dirname = dirname(_filename);

const environment: string = process.env.NODE_ENV || "production";

assertProductionSecretsAreSet(config, environment);

const logLevel: string = config.get("logger:level") || (environment === "production" ? "info" : "debug");
const logger = Logger(logLevel, config.get("logger:file"));
console.log("Log Level=" + logLevel);

const objectFactory = new ObjectFactory(config, logger);

// @rapidmx/restapi's routes/jobs pull these via string-token @Inject(...) — they only resolve once
// something has explicitly registered a concrete implementation under that exact token (there is no
// config-driven auto-wiring for these). See @rapidmx/restapi's own README ("Usage") and .claude/NOTES.md.
objectFactory.register(LocalFsBlobStore, "BlobStore");
objectFactory.register(MongoTextSearchProvider, "SearchProvider");
objectFactory.register(RspamdSpamScanProvider, "SpamScanProvider");
objectFactory.register(ClamAvScanProvider, "AvScanProvider");
objectFactory.register(PostfixSendmailTransport, "MailTransport");
objectFactory.register(NodeDnsResolver, "DnsResolver");
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
// ManualSigningCertificateEnrollment is the only real (CA-agnostic, human-in-the-loop) implementation
// available today; automated RFC 8823 ACME enrollment is tracked separately (see @rapidmx/restapi's specs).
objectFactory.register(ManualSigningCertificateEnrollment, "SigningCertificateEnrollment");

let server: any = undefined;

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
    server = new Server({ config, basePath: config.get("base_path"), logger, objectFactory });
    await server.start();

    // DEV-ONLY (see enableDevAutoLogin.ts) — a no-op outside of `yarn dev`.
    await mountDevImpersonationRouteIfApplicable(server, objectFactory, logger);
};

void start(config, logger);

const shutdown = async () => {
    logger.info("Shutting down...");
    if (server) {
        await server.stop();
    }
    if (objectFactory) {
        await objectFactory.destroy();
    }
    process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
