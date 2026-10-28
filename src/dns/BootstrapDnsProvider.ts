///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
    assertDnsProviderCredentials,
    assertDnsProviderSecretValues,
    AuditAction,
    dnsProviderSecretKeys,
    findAllRows,
    getDnsProviderType,
    isDuplicateKeyError,
    newDnsProviderUid,
    noConfigCipher,
    normalizeDnsProviderOptions,
    normalizeDnsZones,
    notifyDnsPublisher,
    sealDnsCredentials,
    SETUP_STATE_UID,
    toSecretPatch,
    updateSetupState,
    zoneCoverage,
    type AuditLogUtils,
    type ConfigCipher,
    type DnsProvider,
    type DnsProviderOptionValue,
    type DnsProviderType,
    type DnsProviderTypeSpec,
    type DnsPublisher,
    type Domain,
    type SetupState,
} from "@rapidmx/restapi";
import type { RepoUtils } from "@rapidrest/service-core";

/** Where the server pod mounts the Secret `<fullname>-dns-bootstrap` (optional: only a deployment installed with a DNS provider has it), one file per credential. */
export const DEFAULT_BOOTSTRAP_CREDENTIALS_DIR = "/etc/rapidmx/dns-bootstrap";

/** The longest display name a provider config takes (restapi's `MAX_DNS_PROVIDER_NAME_LENGTH`). */
const MAX_NAME_LENGTH = 100;

// eslint-disable-next-line no-control-regex -- matching control characters is the point.
const CONTROL_CHARACTER: RegExp = /[\u0000-\u001f\u007f-\u009f]/;

/** The keys `mail:dns:bootstrap_provider` takes: the console's create body without the credentials, which come from the Secret. */
const BOOTSTRAP_PROVIDER_KEYS: readonly string[] = ["name", "type", "zones", "options", "allowTakeover"];

/** The part of a logger this uses. */
export interface BootstrapLogger {
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
}

/** The installer's DNS provider config, as `mail:dns:bootstrap_provider` describes it, validated and normalized as the console's create would. */
export interface BootstrapProvider {
    name: string;
    type: DnsProviderType;
    zones: string[];
    options: Record<string, DnsProviderOptionValue>;
    /** The installer's `--dns-takeover`. */
    allowTakeover: boolean;
}

/**
 * Reads `mail:dns:bootstrap_provider` (restapi spec 12.1): `{ name, type, zones, options }`, plus `allowTakeover` for the installer's `--dns-takeover`, as an
 * object or as the JSON text the chart renders into the service ConfigMap. It is checked with exactly the console's rules (the type's options, the zones, the
 * name), and an unknown key is refused, naming it, rather than ignored: the config is created once and never from the configuration again.
 *
 * @returns The config; `{}` for a deployment installed without a provider (nothing set, or an empty object); or the `problem` with what was set.
 */
export function parseBootstrapProvider(value: unknown): { provider?: BootstrapProvider; problem?: string } {
    let raw: unknown = value;
    if (typeof raw === "string") {
        if (raw.trim() === "") {
            return {};
        }
        try {
            raw = JSON.parse(raw);
        } catch {
            // The parser's own message quotes the text.
            return { problem: "mail:dns:bootstrap_provider is not valid JSON." };
        }
    }
    if (raw === undefined || raw === null) {
        return {};
    }
    if (typeof raw !== "object" || Array.isArray(raw)) {
        return { problem: "mail:dns:bootstrap_provider must be an object of name, type, zones and options." };
    }
    const body: Record<string, unknown> = raw as Record<string, unknown>;
    if (Object.keys(body).length === 0) {
        return {};
    }
    try {
        const unknown: string | undefined = Object.keys(body).find((key) => !BOOTSTRAP_PROVIDER_KEYS.includes(key));
        if (unknown !== undefined) {
            throw new Error(`mail:dns:bootstrap_provider has no setting '${unknown}'; its settings are ${BOOTSTRAP_PROVIDER_KEYS.join(", ")}.`);
        }
        const name: string | undefined = typeof body.name === "string" ? body.name.trim() : undefined;
        if (!name || name.length > MAX_NAME_LENGTH || CONTROL_CHARACTER.test(name)) {
            throw new Error(`mail:dns:bootstrap_provider 'name' must be text of 1 to ${MAX_NAME_LENGTH} characters.`);
        }
        if (body.allowTakeover !== undefined && typeof body.allowTakeover !== "boolean") {
            throw new Error("mail:dns:bootstrap_provider 'allowTakeover' must be true or false.");
        }
        const spec: DnsProviderTypeSpec = getDnsProviderType(body.type);
        const zones: string[] = normalizeDnsZones(body.zones);
        const options: Record<string, DnsProviderOptionValue> = normalizeDnsProviderOptions(spec, body.options ?? {}, zones);
        return { provider: { name, type: spec.type, zones, options, allowTakeover: body.allowTakeover === true } };
    } catch (err: any) {
        return { problem: err?.message ?? "mail:dns:bootstrap_provider is invalid." };
    }
}

/** Whether `err` is the filesystem saying there is no such file or directory. */
function isMissing(err: any): boolean {
    return err?.code === "ENOENT" || err?.code === "ENOTDIR";
}

/**
 * The credentials of the installer's config: one file per credential field of `spec` in `dir` (the mounted Secret `<fullname>-dns-bootstrap`, whose keys are
 * the field names), each trimmed of the newline a file usually ends with and checked for its field's format as the console checks a form. No directory, no
 * file, or an empty file is no credential (a Route 53 config through IRSA has none, and the volume is optional). A file that is not a field of the type is
 * left out and named in a warning, never its content; the dotted entries Kubernetes keeps in a mounted Secret are not looked at.
 *
 * @throws If a value is not acceptable (the error names the field, never the value), or a file can't be read.
 */
export async function readBootstrapCredentials(dir: string, spec: DnsProviderTypeSpec, logger?: Pick<BootstrapLogger, "warn">): Promise<Record<string, string>> {
    let entries: string[];
    try {
        entries = await readdir(dir);
    } catch (err: any) {
        if (isMissing(err)) {
            return {};
        }
        throw err;
    }
    const { fields, multiLineFields } = dnsProviderSecretKeys(spec);
    const unexpected: string[] = entries.filter((entry) => !entry.startsWith(".") && !fields.includes(entry));
    if (unexpected.length > 0) {
        logger?.warn(`The DNS bootstrap credentials in ${dir} have files that are not credentials of a '${spec.type}' provider, which are ignored: ${unexpected.join(", ")}.`);
    }
    const found: Record<string, string> = {};
    for (const field of fields) {
        let content: string;
        try {
            content = await readFile(join(dir, field), "utf-8");
        } catch (err: any) {
            if (isMissing(err)) {
                continue;
            }
            throw err;
        }
        if (content.trim() !== "") {
            found[field] = content;
        }
    }
    const patch: Record<string, string | null> = toSecretPatch(found, fields, multiLineFields);
    assertDnsProviderSecretValues(spec, patch);
    return Object.fromEntries(Object.entries(patch).filter((entry): entry is [string, string] => entry[1] !== null));
}

/** The credential fields of `spec` the Secret directory holds a file for (names only, never a content); none where there is no directory or it can't be read. */
async function bootstrapCredentialFiles(dir: string, spec: DnsProviderTypeSpec): Promise<string[]> {
    try {
        const entries: string[] = await readdir(dir);
        return dnsProviderSecretKeys(spec).fields.filter((field) => entries.includes(field));
    } catch {
        return [];
    }
}

/** What `createBootstrapDnsProvider()` did. */
export type BootstrapDnsProviderResult =
    /** The deployment was installed without a provider. */
    | { status: "none" }
    /** The config was created now. */
    | { status: "created"; uid: string }
    /** The installer's config was there already, or was made on an earlier start and deleted since in the console (it is never made again, so no `uid`), or
     * another server copy just made it (no `uid` here either). */
    | { status: "exists"; uid?: string }
    /** It could not be created; the next start tries again. */
    | { status: "failed"; reason: string };

export interface BootstrapDnsProviderOptions {
    /** `mail:dns:bootstrap_provider`. */
    value: unknown;
    /** Where the Secret `<fullname>-dns-bootstrap` is mounted. */
    credentialsDir: string;
    /** The `DnsProvider` repository. */
    providers: RepoUtils<any>;
    /** The `SetupState` repository, whose row records that the config was created so that deleting it in the console is final. Without one nothing is recorded. */
    setupState?: RepoUtils<any>;
    /** The `Domain` repository, to refuse a zone that would take a domain from the config it is assigned to. */
    domains?: RepoUtils<any>;
    /** The datastore's `DnsProviderMongo` or `DnsProviderSQL`. */
    providerClass: new (fields: Record<string, unknown>) => DnsProvider;
    /** Seals the credentials; none registered means a config that needs credentials can't be created. */
    cipher?: Pick<ConfigCipher, "encrypt">;
    audit?: Pick<AuditLogUtils, "record">;
    publisher?: DnsPublisher;
    logger?: BootstrapLogger;
}

/** The reason a failure is logged and returned with: the error's own message, which the restapi helpers keep free of values. */
function reasonOf(err: any): string {
    return err?.message || "unknown error";
}

/** Records on the setup row that the installer's config was created, unless another copy recorded its own already. A failure is logged, never thrown: the
 * config is there, which keeps a start from creating it again until it is deleted, and the next start records it. */
async function recordCreated(options: BootstrapDnsProviderOptions, uid: string): Promise<void> {
    if (!options.setupState) {
        return;
    }
    try {
        await updateSetupState(options.setupState, async (current: SetupState) => (current.bootstrapDnsProviderUid ? undefined : { bootstrapDnsProviderUid: uid }));
    } catch (err: any) {
        options.logger?.warn(`The creation of the installer's DNS provider could not be recorded: ${reasonOf(err)}`);
    }
}

/**
 * Says, when the installer's config exists already, that `mail:dns:bootstrap_provider` and the Secret are not applied to it: a re-installation with another
 * provider, other zones or new credentials changes nothing here, and its credentials would otherwise vanish with the Secret without a trace. Nothing is said
 * when the setting matches the config and the Secret holds no credential, which is every restart of a deployment installed once. Never a value.
 */
async function noteExisting(options: BootstrapDnsProviderOptions, provider: BootstrapProvider | undefined, config: DnsProvider | undefined): Promise<void> {
    const { logger } = options;
    if (!provider) {
        return;
    }
    if (!config) {
        logger?.info(
            "The DNS provider the installer configured was created on an earlier start and has been deleted since, so it is not created again. " +
                "Add a DNS provider in the admin console to publish DNS records.",
        );
        return;
    }
    const files: string[] = await bootstrapCredentialFiles(options.credentialsDir, getDnsProviderType(provider.type));
    const sameZones: boolean = [...config.zones].sort().join(",") === [...provider.zones].sort().join(",");
    const differs: boolean = config.type !== provider.type || config.name.toLowerCase() !== provider.name.toLowerCase() || !sameZones;
    if (differs || files.length > 0) {
        logger?.warn(
            `The DNS provider the installer configured already exists ('${config.name}'), so ${differs ? "mail:dns:bootstrap_provider " : ""}` +
                `${differs && files.length > 0 ? "and " : ""}${files.length > 0 ? `the bootstrap credentials (${files.join(", ")}) ` : ""}` +
                "are not applied to it. Change its settings and credentials in the admin console.",
        );
    }
}

/**
 * Creates the DNS provider config the installer asked for (restapi spec 12.1) from `mail:dns:bootstrap_provider` and the credentials of the
 * `<fullname>-dns-bootstrap` Secret, once: the config is made only while no `DnsProvider` has `origin: "installer"` and `SetupState.bootstrapDnsProviderUid`
 * is unset (recorded right after the creation, as `DomainSeeder` records a seeded domain), so a restart, another server copy, a re-installation and the
 * administrator's edits in the console, deleting the config included, never meet a second one or an overwritten one. When the setting or the Secret differs
 * from the config that is there, a warning says that it is changed in the console. It is created exactly as the console creates one
 * (the same validation of the type's options, zones and credentials, the name and zones free, the credentials sealed for their row and field in the row's one
 * write with `credentialsGeneration` 1), with `origin: "installer"`, audited as `DNS_PROVIDER_CREATE` with no user and announced to the DNS controller.
 *
 * Never throws: what can't be created (a config the console would refuse, credentials the type needs that the Secret doesn't have, no keyring, a name or a
 * zone another config has, a datastore that fails, a setup row that can't be read) is logged, with the reason and never a credential, and returned as `failed`; the next start tries again,
 * and the domains that name the installer's provider are created manual meanwhile.
 */
export async function createBootstrapDnsProvider(options: BootstrapDnsProviderOptions): Promise<BootstrapDnsProviderResult> {
    const { logger } = options;
    const failed = (reason: string): BootstrapDnsProviderResult => {
        logger?.error(`The DNS provider the installer configured was not created: ${reason} The next start tries again.`);
        return { status: "failed", reason };
    };
    try {
        const { provider, problem } = parseBootstrapProvider(options.value);
        if (!provider && !problem) {
            return { status: "none" };
        }
        // Created before: the config is there, or the setup row says it was and the administrator deleted it. Without the row's say a deleted config would
        // come back (published again, with its credentials) at the next start of any copy. When the row can't be read nothing is created: it might say so.
        let recorded: string | undefined;
        try {
            const state: SetupState | undefined = (await options.setupState?.findOne(SETUP_STATE_UID, { ignoreACL: true })) ?? undefined;
            recorded = state?.bootstrapDnsProviderUid;
        } catch (err: any) {
            return failed(`Whether it was created before can't be read: ${reasonOf(err)}`);
        }
        const existing: DnsProvider[] = await findAllRows<DnsProvider>(options.providers, { origin: "installer" });
        if (existing.length > 0 || recorded) {
            if (existing.length > 0 && !recorded) {
                await recordCreated(options, existing[0].uid);
            }
            await noteExisting(options, provider, existing[0]);
            return existing.length > 0 ? { status: "exists", uid: existing[0].uid } : { status: "exists" };
        }
        if (!provider) {
            return failed(problem!);
        }

        const others: DnsProvider[] = await findAllRows<DnsProvider>(options.providers, {});
        const nameKey: string = provider.name.toLowerCase();
        if (others.some((other) => other.name.toLowerCase() === nameKey)) {
            return failed(`A DNS provider named '${provider.name}' already exists.`);
        }
        for (const other of others) {
            const shared: string | undefined = provider.zones.find((zone) => other.zones.includes(zone));
            if (shared) {
                return failed(`The zone '${shared}' is already used by the DNS provider '${other.name}'; a zone belongs to one DNS provider only.`);
            }
        }
        // The new config's instance would take over a domain another config covers less specifically, and delete its records (restapi spec 7.4).
        for (const other of options.domains ? others : []) {
            const assigned: Domain[] = await findAllRows<Domain>(options.domains!, { dnsProviderUid: other.uid });
            const taken: Domain | undefined = assigned.find((domain) => {
                const current: number = zoneCoverage(domain.name, other.zones);
                return current >= 0 && zoneCoverage(domain.name, provider.zones) > current;
            });
            if (taken) {
                return failed(`'${taken.name}' is assigned to the DNS provider '${other.name}', but the installer's zones cover it more specifically; set it to manual first.`);
            }
        }

        const spec: DnsProviderTypeSpec = getDnsProviderType(provider.type);
        const values: Record<string, string> = await readBootstrapCredentials(options.credentialsDir, spec, logger);
        assertDnsProviderCredentials(spec, provider.options, Object.keys(values));
        const uid: string = newDnsProviderUid(provider.name);
        const hasCredentials: boolean = Object.keys(values).length > 0;
        // Sealed before anything is written, so a server without a keyring creates nothing.
        if (hasCredentials && !options.cipher) {
            throw noConfigCipher();
        }
        const credentials = hasCredentials ? sealDnsCredentials(options.cipher as ConfigCipher, uid, values) : undefined;

        try {
            await options.providers.create(
                new options.providerClass({
                    uid,
                    name: provider.name,
                    nameKey,
                    type: provider.type,
                    zones: provider.zones,
                    options: provider.options,
                    ...(credentials ? { credentials, credentialsGeneration: 1 } : {}),
                    origin: "installer",
                    enabled: true,
                    allowTakeover: provider.allowTakeover,
                }),
                { ignoreACL: true },
            );
        } catch (err: any) {
            // Another server copy starting at the same moment created it first: the unique index on the name says so.
            if (isDuplicateKeyError(err)) {
                const winner: DnsProvider[] = await findAllRows<DnsProvider>(options.providers, { origin: "installer" }).catch(() => []);
                if (winner.length > 0) {
                    await recordCreated(options, winner[0].uid);
                }
                return { status: "exists" };
            }
            throw err;
        }

        await recordCreated(options, uid);
        try {
            await options.audit?.record({
                action: AuditAction.DNS_PROVIDER_CREATE,
                targetType: "DnsProvider",
                targetUid: uid,
                details: {
                    name: provider.name,
                    type: provider.type,
                    zones: provider.zones,
                    optionKeys: Object.keys(provider.options).sort(),
                    credentialsChanged: hasCredentials,
                    origin: "installer",
                },
            });
        } catch (err: any) {
            logger?.warn(`The creation of the installer's DNS provider could not be audited: ${reasonOf(err)}`);
        }
        await notifyDnsPublisher(options.publisher, { scope: "provider", providerUid: uid }, logger);
        logger?.info(`Created the DNS provider '${provider.name}' (${provider.type}, zones ${provider.zones.join(", ")}) the installer configured.`);
        return { status: "created", uid };
    } catch (err: any) {
        return failed(reasonOf(err));
    }
}
