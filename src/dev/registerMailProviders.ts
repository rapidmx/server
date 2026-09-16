///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { PostfixSendmailTransport, SesMailTransport } from "@rapidmx/restapi";
import { ClamAvScanProvider, RspamdSpamScanProvider } from "@rapidmx/restapi/scan";
import { DEVELOPMENT_ENVIRONMENTS } from "../config.defaults.js";
import { selectConfigDrivenBackend } from "../lib/configDrivenBackend.js";
import { DevBypassAvScanProvider, DevBypassSpamScanProvider } from "./DevScanBypass.js";
import type { DevLocalDeliveryTransport } from "./DevLocalDeliveryTransport.js";

/** The part of `ObjectFactory` this needs. */
export interface ClassRegistry {
    register(clazz: any, fqn?: string): void;
}

/**
 * Registers the `"SpamScanProvider"`, `"AvScanProvider"` and `"MailTransport"` implementations `@rapidmx/restapi`'s
 * `ScanPipeline`, routes and jobs inject.
 *
 * Any `NODE_ENV` other than `dev`/`development`/`test` (production, unset, anything unexpected) registers the real
 * `RspamdSpamScanProvider`, `ClamAvScanProvider` and a real `MailTransport`, which fail closed when rspamd, clamd or the
 * MTA are down. The transport is config-driven (`mail:transport:provider`), same pattern as `mail:blob:backend`:
 * `"postfix"` (default) hands outbound mail to the `postfix-bridge` chart's Postfix over sendmail/msmtp, `"ses"` to AWS
 * SES's SendEmail API (`SesMailTransport`, credentials from the standard AWS chain - an IAM role - and `mail:transport:
 * ses:region`), for a deployment whose inbound mail comes from `ses-bridge` rather than Postfix.
 *
 * A development `NODE_ENV` registers the DEV-ONLY wrappers instead, so `yarn dev` can send mail without
 * docker-compose.mail.yml's scanners or a Postfix: `DevBypassSpamScanProvider`/`DevBypassAvScanProvider` (an unreachable
 * engine is treated as clean, with a warning) and `devTransport` (local delivery when there's no sendmail binary). Each
 * uses the real implementation unchanged whenever that service is there.
 *
 * @param objectFactory The server's `ObjectFactory`.
 * @param devTransport The datastore's `DevLocalDeliveryTransport` subclass, used only in development.
 * @param environment The raw `NODE_ENV`.
 * @param config The loaded runtime configuration, read for `mail:transport:provider`.
 */
export function registerMailProviders(
    objectFactory: ClassRegistry,
    devTransport: new () => DevLocalDeliveryTransport,
    environment: string | undefined,
    config: { get(key: string): unknown },
): void {
    if (environment !== undefined && DEVELOPMENT_ENVIRONMENTS.includes(environment)) {
        objectFactory.register(DevBypassSpamScanProvider, "SpamScanProvider");
        objectFactory.register(DevBypassAvScanProvider, "AvScanProvider");
        objectFactory.register(devTransport, "MailTransport");
        return;
    }
    objectFactory.register(RspamdSpamScanProvider, "SpamScanProvider");
    objectFactory.register(ClamAvScanProvider, "AvScanProvider");
    objectFactory.register(
        selectConfigDrivenBackend(config, "mail:transport:provider", "ses", PostfixSendmailTransport, SesMailTransport),
        "MailTransport",
    );
}
