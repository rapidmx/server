///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { AuditLogUtils, BOOTSTRAP_DNS_PROVIDER, parseSeedDomainEntries, resolveDnsPublisher, type ConfigCipher, type DomainSeedResult } from "@rapidmx/restapi";
import { RepoUtils } from "@rapidrest/service-core";
import {
    createBootstrapDnsProvider,
    DEFAULT_BOOTSTRAP_CREDENTIALS_DIR,
    type BootstrapDnsProviderResult,
    type BootstrapLogger,
} from "../dns/BootstrapDnsProvider.js";

/** The part of the `ObjectFactory` this needs. */
export interface InstallationFactory {
    newInstance<T>(type: any, options?: { name?: string; args?: unknown[] }): T | Promise<T>;
}

/** The datastore's classes: `DnsProviderMongo`/`DomainMongo`/`SetupStateMongo`/`AuditLogEntryMongo`/`DomainSeederMongo`, or their SQL counterparts. */
export interface InstallationClasses {
    dnsProviderClass: any;
    domainClass: any;
    setupStateClass: any;
    auditLogClass: any;
    domainSeederClass: any;
}

/** What `seedInstallation()` did. */
export interface InstallationSeeded {
    dnsProvider: BootstrapDnsProviderResult;
    /** What the domain seeder did; unset when it could not run. */
    domains?: DomainSeedResult;
}

/**
 * Takes the entries of `mail:domains` that name the installer's DNS provider out of the list `seeder` is about to seed, saying which. The seeder reads its
 * list once from the configuration when it is built, so this replaces what it holds; the entries that are malformed are reported here, as the seeder would,
 * since the list it is left with has none.
 */
function holdBackBootstrapDomains(seeder: object, value: unknown, logger: BootstrapLogger): void {
    const { entries, problems } = parseSeedDomainEntries(value);
    const held: string[] = entries.filter((entry) => entry.dnsProvider === BOOTSTRAP_DNS_PROVIDER).map((entry) => entry.name);
    if (held.length === 0) {
        return;
    }
    for (const problem of problems) {
        logger.warn(`DomainSeeder: ${problem}`);
    }
    (seeder as { domains: unknown }).domains = entries.filter((entry) => entry.dnsProvider !== BOOTSTRAP_DNS_PROVIDER);
    logger.warn(
        `Not seeding ${held.join(", ")} on this start: ${held.length === 1 ? "it names" : "they name"} the installer's DNS provider, which was not created (see above). ` +
            "Correct that and restart to seed them with it.",
    );
}

/**
 * Sets up what the deployment was installed for, once the server's datastores are connected (restapi spec 12.1, 13.3): first the DNS provider config the
 * installer asked for (`mail:dns:bootstrap_provider` and the credentials of the `<fullname>-dns-bootstrap` Secret, in `mail:dns:bootstrap_credentials_dir`),
 * then the domains of `mail:domains`, so a domain that names `"bootstrap"` as its provider can be assigned to it. Both are idempotent and safe across server
 * copies, so every copy does it on every start (see `createBootstrapDnsProvider()` and restapi's `DomainSeeder`).
 *
 * A domain that names `"bootstrap"` is held back on a start whose provider config could not be created: the seeder would create it manual and record it as
 * seeded, which it never revisits, so it would stay unpublished for good. It is seeded on the first start that has the config.
 *
 * Never throws and never stops the server from starting: what fails is logged, and the next start tries again.
 *
 * @param objectFactory The server's `ObjectFactory`.
 * @param config The runtime configuration.
 * @param logger Where the outcome is said.
 * @param classes The datastore's classes.
 */
export async function seedInstallation(
    objectFactory: InstallationFactory,
    config: { get(key: string): unknown },
    logger: BootstrapLogger,
    classes: InstallationClasses,
): Promise<InstallationSeeded> {
    let dnsProvider: BootstrapDnsProviderResult;
    try {
        const providers: RepoUtils<any> = await objectFactory.newInstance(RepoUtils, { name: classes.dnsProviderClass.name, args: [classes.dnsProviderClass] });
        const domains: RepoUtils<any> = await objectFactory.newInstance(RepoUtils, { name: classes.domainClass.name, args: [classes.domainClass] });
        const setupState: RepoUtils<any> = await objectFactory.newInstance(RepoUtils, { name: classes.setupStateClass.name, args: [classes.setupStateClass] });
        const auditLogRepo: RepoUtils<any> = await objectFactory.newInstance(RepoUtils, { name: classes.auditLogClass.name, args: [classes.auditLogClass] });
        const audit: AuditLogUtils = await objectFactory.newInstance(AuditLogUtils, { name: classes.auditLogClass.name, args: [auditLogRepo] });
        // Without a registered cipher a config that needs credentials is not created, and says why.
        let cipher: ConfigCipher | undefined;
        try {
            cipher = await objectFactory.newInstance<ConfigCipher>("ConfigCipher", { name: "default" });
        } catch {
            cipher = undefined;
        }
        dnsProvider = await createBootstrapDnsProvider({
            value: config.get("mail:dns:bootstrap_provider"),
            credentialsDir: (config.get("mail:dns:bootstrap_credentials_dir") as string | undefined) || DEFAULT_BOOTSTRAP_CREDENTIALS_DIR,
            providers,
            setupState,
            domains,
            providerClass: classes.dnsProviderClass,
            cipher,
            audit,
            publisher: await resolveDnsPublisher(objectFactory, logger),
            logger,
        });
    } catch (err: any) {
        logger.error(`The DNS provider the installer configured could not be created: ${err?.message} The next start tries again.`);
        dnsProvider = { status: "failed", reason: err?.message ?? "unknown error" };
    }

    let domains: DomainSeedResult | undefined;
    try {
        const seeder: { run(): Promise<DomainSeedResult> } = await objectFactory.newInstance(classes.domainSeederClass, { name: "default" });
        if (dnsProvider.status === "failed") {
            holdBackBootstrapDomains(seeder, config.get("mail:domains"), logger);
        }
        domains = await seeder.run();
        if (domains.created.length > 0 || domains.recorded.length > 0 || domains.adopted.length > 0) {
            logger.info(
                `Domains of this installation: created ${domains.created.join(", ") || "none"}` +
                    (domains.recorded.length > 0 ? `; already there ${domains.recorded.join(", ")}` : "") +
                    (domains.adopted.length > 0 ? `; recorded without creating ${domains.adopted.join(", ")}` : "") +
                    ".",
            );
        }
        if (domains.skipped > 0) {
            logger.warn(`${domains.skipped} entries of mail:domains were skipped; each is explained above. Correct them and restart to seed them.`);
        }
    } catch (err: any) {
        logger.error(`The domains of this installation could not be seeded: ${err?.message} The next start tries again.`);
    }
    return { dnsProvider, domains };
}
