///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import {
    GIPHY_API_KEY_FIELD,
    integrationSecretContext,
    isConfigEnvelope,
    PLUGIN_REGISTRY_TOKEN_FIELD,
    pluginNamespaceTokenField,
    type ConfigCipher,
    type IntegrationSettings,
    type IntegrationSettingsResponse,
    type SecretMask,
} from "@rapidmx/restapi";
import type { UnreadableSecretMask } from "./markUnreadableCredentials.js";
import { UnreadableSecrets } from "./UnreadableSecrets.js";

/**
 * `view` with `unreadable: true` added to the mask of each secret the process couldn't read (restapi spec 10.2, "Unreadable secrets in the view"): the Giphy key,
 * the registry token and a namespace's token. It never decrypts, and answers as `markUnreadableCredentials()` does: from what an earlier decryption in this
 * process said (`UnreadableSecrets`, which the integrations layer fills when it rebuilds), and from whether the key the envelope names is one this process has
 * loaded at all, which holds in every server copy at once (a backup restored with an older keyring). A secret entered again is a new envelope under the
 * active key, so it counts as readable at once. Only what the administrator saved can be unreadable: the deployment's own values (`defaults`) are no envelopes.
 *
 * @param view The view as restapi's route makes it, with a plain mask per secret saved.
 * @param settings The row it was made from, whose envelopes say which secret is which.
 * @param cipher The server's cipher, which knows the keys this process has loaded.
 */
export function markUnreadableIntegrations(
    view: IntegrationSettingsResponse,
    settings: IntegrationSettings | undefined,
    cipher?: Pick<ConfigCipher, "loadedKids">,
): IntegrationSettingsResponse {
    const loaded: string[] | undefined = cipher?.loadedKids();
    const unreadable = (field: string, envelope: unknown): boolean =>
        (!!loaded && isConfigEnvelope(envelope) && !loaded.includes(envelope.kid)) || UnreadableSecrets.isUnreadable(integrationSecretContext(field), envelope);
    const marked = (mask: unknown): unknown => ({ ...(mask as SecretMask), unreadable: true }) satisfies UnreadableSecretMask;
    const isMask = (value: unknown): boolean => typeof value === "object" && value !== null && (value as SecretMask).secret === true;

    const result: IntegrationSettingsResponse = { ...view };

    const giphy = settings?.giphy;
    if (giphy?.apiKey && isMask(view.giphy.values.apiKey) && unreadable(GIPHY_API_KEY_FIELD, giphy.apiKey)) {
        result.giphy = { ...view.giphy, values: { ...view.giphy.values, apiKey: marked(view.giphy.values.apiKey) } };
    }

    const registry = settings?.pluginRegistry;
    if (registry) {
        const values: Record<string, unknown> = { ...view.pluginRegistry.values };
        let changed = false;
        if (registry.token && isMask(values.token) && unreadable(PLUGIN_REGISTRY_TOKEN_FIELD, registry.token)) {
            values.token = marked(values.token);
            changed = true;
        }
        if (Array.isArray(values.namespaces) && view.pluginRegistry.source.namespaces === "admin") {
            values.namespaces = (values.namespaces as { name: string; token?: unknown }[]).map((namespace) => {
                const envelope = registry.namespaces?.find((saved) => saved.name === namespace.name)?.token;
                if (envelope && isMask(namespace.token) && unreadable(pluginNamespaceTokenField(namespace.name), envelope)) {
                    changed = true;
                    return { ...namespace, token: marked(namespace.token) };
                }
                return namespace;
            });
        }
        if (changed) {
            result.pluginRegistry = { ...view.pluginRegistry, values };
        }
    }
    return result;
}
