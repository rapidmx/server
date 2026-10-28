///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
// Shared pieces of the live-integrations tests (spec 11): a configuration laid out as config.mongo.ts/config.sql.ts lay it out, with the plugin settings
// layer on top and the integrations layer below it, the plugin host's keyring-only cipher, and a settings row with its secrets sealed as the route seals them.
import nconf from "nconf";
import { Logger } from "@rapidrest/core";
import { ObjectFactory } from "@rapidrest/service-core";
import {
    ConfigCipher,
    generateConfigKeyring,
    GIPHY_API_KEY_FIELD,
    integrationSecretContext,
    PLUGIN_REGISTRY_TOKEN_FIELD,
    pluginNamespaceTokenField,
    type ConfigEnvelope,
} from "@rapidmx/restapi";
import { INTEGRATIONS_STORE, PLUGIN_SETTINGS_STORE } from "../../src/config.defaults.js";
import { createPluginHostCipher } from "../../src/lib/configEncryption.js";

/** A configuration with the two literal layers in the order the shipped configs add them, over `deployment` as the defaults. */
export function layeredConfig(deployment: Record<string, any> = {}, extra: Record<string, any> = {}) {
    const conf = new nconf.Provider();
    conf.add(PLUGIN_SETTINGS_STORE, { type: "literal", store: {} });
    conf.add(INTEGRATIONS_STORE, { type: "literal", store: {} });
    conf.use("memory");
    conf.defaults({ base_path: "./src/mongo", config_encryption: { keyring: JSON.stringify(generateConfigKeyring()) }, ...deployment, ...extra });
    return conf;
}

/** What the worker builds for the plugin host and the integrations layer: restapi's cipher over the configuration's keyring, with no datastore. */
export async function keyringCipher(conf: ReturnType<typeof layeredConfig>): Promise<{ cipher: ConfigCipher; factory: ObjectFactory }> {
    const factory = new ObjectFactory(conf, new Logger());
    return { cipher: await createPluginHostCipher(factory), factory };
}

export const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() });

/** The `IntegrationSettings` row an administrator's changes leave, with `secrets` sealed for their fields. */
export function settingsRow(
    cipher: Pick<ConfigCipher, "encrypt">,
    values: {
        version?: number;
        giphy?: { enabled?: boolean; apiKey?: string };
        stun?: { urls: string[] };
        signingCa?: Record<string, string>;
        dnsResolver?: Record<string, string>;
        pluginRegistry?: { url?: string; token?: string; namespaces?: { name: string; registry?: string; token?: string }[] };
    },
): any {
    const seal = (value: string | undefined, field: string): ConfigEnvelope | undefined => (value === undefined ? undefined : cipher.encrypt(value, integrationSecretContext(field)));
    const row: any = { uid: "integrations", version: values.version ?? 1 };
    if (values.giphy) {
        row.giphy = { enabled: values.giphy.enabled, apiKey: seal(values.giphy.apiKey, GIPHY_API_KEY_FIELD) };
    }
    if (values.stun) {
        row.stun = values.stun;
    }
    if (values.signingCa) {
        row.signingCa = values.signingCa;
    }
    if (values.dnsResolver) {
        row.dnsResolver = values.dnsResolver;
    }
    if (values.pluginRegistry) {
        const registry = values.pluginRegistry;
        row.pluginRegistry = {
            url: registry.url,
            token: seal(registry.token, PLUGIN_REGISTRY_TOKEN_FIELD),
            namespaces: registry.namespaces?.map(({ token, ...namespace }) => ({ ...namespace, ...(token !== undefined ? { token: seal(token, pluginNamespaceTokenField(namespace.name)) } : {}) })),
        };
    }
    return row;
}
