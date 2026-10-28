///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
// Shared pieces of the tests that start a real server for the installation's own setup (the installer's DNS provider config, the seeded domains).
import fs from "fs";
import os from "os";
import path from "path";
import {
    dnsCredentialContext,
    findAllRows,
    generateConfigKeyring,
    SETUP_STATE_UID,
    updateSetupState,
    type ConfigCipher,
    type DnsProvider,
    type Domain,
    type SetupState,
} from "@rapidmx/restapi";
import { ObjectFactory, RepoUtils } from "@rapidrest/service-core";

export const BOOTSTRAP_TOKEN = "cf-secret-token-0123456789";
export const BOOTSTRAP_ZONE_ID = "0123456789abcdef0123456789abcdef";

/** The installer's provider config and the domains a deployment installed with `--dns-provider cloudflare` has in its configuration. */
export const INSTALLED_PROVIDER = { name: "Installer Cloudflare", type: "cloudflare", zones: ["example.com"], options: { zoneIds: [BOOTSTRAP_ZONE_ID] } };
export const INSTALLED_DOMAINS = ["example.com", { name: "shop.example.com", dnsProvider: "bootstrap" }, { name: "other.org", dnsProvider: "bootstrap" }];

/** The directories the test keeps the mounted Secret and the DKIM keys in. */
export interface InstallationFixture {
    credentialsDir: string;
    dkimDir: string;
    remove(): void;
}

export function installationFixture(): InstallationFixture {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "installation-"));
    const credentialsDir = path.join(root, "dns-bootstrap");
    const dkimDir = path.join(root, "dkim");
    fs.mkdirSync(credentialsDir);
    fs.mkdirSync(dkimDir);
    fs.writeFileSync(path.join(credentialsDir, "apiToken"), `${BOOTSTRAP_TOKEN}\n`);
    return { credentialsDir, dkimDir, remove: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/** Configures what the chart and the installer would: the keyring, the bootstrap provider and its Secret, the domains, and a DKIM directory that can be written. */
export function configureInstallation(config: { set(key: string, value: unknown): void }, fixture: InstallationFixture): void {
    config.set("config_encryption:keyring", JSON.stringify(generateConfigKeyring()));
    config.set("mail:dkim:key_dir", fixture.dkimDir);
    config.set("mail:dns:bootstrap_provider", JSON.stringify(INSTALLED_PROVIDER));
    config.set("mail:dns:bootstrap_credentials_dir", fixture.credentialsDir);
    config.set("mail:domains", INSTALLED_DOMAINS);
}

/** What a probe of the datastore finds of the installation. */
export async function installationRows(
    objectFactory: ObjectFactory,
    classes: { dnsProviderClass: any; domainClass: any; auditLogClass: any },
): Promise<{ providers: DnsProvider[]; domains: Domain[]; audit: any[] }> {
    const repo = (clazz: any) => objectFactory.newInstance<RepoUtils<any>>(RepoUtils, { name: clazz.name, args: [clazz] });
    return {
        providers: await findAllRows<DnsProvider>(await repo(classes.dnsProviderClass), {}),
        domains: await findAllRows<Domain>(await repo(classes.domainClass), {}),
        audit: await findAllRows<any>(await repo(classes.auditLogClass), {}),
    };
}

/** The token of the installer's provider, decrypted as the controller's credentials request does. */
export async function bootstrapToken(objectFactory: ObjectFactory, provider: DnsProvider): Promise<string> {
    const cipher = await objectFactory.newInstance<ConfigCipher>("ConfigCipher", { name: "default" });
    return cipher.decryptString(provider.credentials!.apiToken, dnsCredentialContext(provider.uid, "apiToken"));
}

/** The `SetupState` row, which records that the installer's provider config was created. */
export async function setupStateRow(objectFactory: ObjectFactory, classes: { setupStateClass: any }): Promise<SetupState> {
    const repo = await objectFactory.newInstance<RepoUtils<any>>(RepoUtils, { name: classes.setupStateClass.name, args: [classes.setupStateClass] });
    return repo.findOne(SETUP_STATE_UID, { ignoreACL: true });
}

/** Deletes the installer's provider config the way the console's DELETE does (the row only), and with `forget` also takes the record of its creation away,
 * which makes the deployment one that has never started. */
export async function deleteInstallerProvider(
    objectFactory: ObjectFactory,
    classes: { dnsProviderClass: any; setupStateClass: any },
    options: { forget?: boolean } = {},
): Promise<void> {
    const repo = (clazz: any) => objectFactory.newInstance<RepoUtils<any>>(RepoUtils, { name: clazz.name, args: [clazz] });
    const providers = await repo(classes.dnsProviderClass);
    for (const provider of await findAllRows<DnsProvider>(providers, { origin: "installer" })) {
        await providers.delete(provider.uid, { ignoreACL: true });
    }
    if (options.forget) {
        await updateSetupState(await repo(classes.setupStateClass), async () => ({ bootstrapDnsProviderUid: null as any }));
    }
}
