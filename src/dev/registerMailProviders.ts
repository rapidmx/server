///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { PostfixSendmailTransport } from "@rapidmx/restapi";
import { ClamAvScanProvider, RspamdSpamScanProvider } from "@rapidmx/restapi/scan";
import { DEVELOPMENT_ENVIRONMENTS } from "../config.defaults.js";
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
 * `RspamdSpamScanProvider`, `ClamAvScanProvider` and `PostfixSendmailTransport`, which fail closed when rspamd, clamd or
 * the MTA are down. A development `NODE_ENV` registers the DEV-ONLY wrappers instead, so `yarn dev` can send mail without
 * docker-compose.mail.yml's scanners or a Postfix: `DevBypassSpamScanProvider`/`DevBypassAvScanProvider` (an unreachable
 * engine is treated as clean, with a warning) and `devTransport` (local delivery when there's no sendmail binary). Each
 * uses the real implementation unchanged whenever that service is there.
 *
 * @param objectFactory The server's `ObjectFactory`.
 * @param devTransport The datastore's `DevLocalDeliveryTransport` subclass, used only in development.
 * @param environment The raw `NODE_ENV`.
 */
export function registerMailProviders(
    objectFactory: ClassRegistry,
    devTransport: new () => DevLocalDeliveryTransport,
    environment: string | undefined,
): void {
    if (environment !== undefined && DEVELOPMENT_ENVIRONMENTS.includes(environment)) {
        objectFactory.register(DevBypassSpamScanProvider, "SpamScanProvider");
        objectFactory.register(DevBypassAvScanProvider, "AvScanProvider");
        objectFactory.register(devTransport, "MailTransport");
        return;
    }
    objectFactory.register(RspamdSpamScanProvider, "SpamScanProvider");
    objectFactory.register(ClamAvScanProvider, "AvScanProvider");
    objectFactory.register(PostfixSendmailTransport, "MailTransport");
}
