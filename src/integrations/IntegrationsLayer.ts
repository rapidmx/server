///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import {
    buildIntegrationsConfigLayer,
    ConfigSecretUnavailableError,
    INTEGRATION_CONFIG_KEYS,
    type ConfigCipher,
    type ConfigCipherContext,
    type ConfigEnvelope,
    type IntegrationSettings,
} from "@rapidmx/restapi";
import { INTEGRATIONS_STORE } from "../config.defaults.js";
import { UnreadableSecrets } from "../secrets/UnreadableSecrets.js";

/** The part of the server's `nconf` instance the layer needs. */
export interface IntegrationsLayerConfig {
    stores?: Record<string, any>;
}

/** What applying a row left: its version, and the secrets that could not be read. */
export interface IntegrationsLayerResult {
    version: number;
    /** The row fields (`giphy.apiKey`, `pluginRegistry.namespaces.@acme.token`) whose secret was left out because it could not be decrypted. */
    unreadable: readonly string[];
}

/** Every config key a section of the Integrations overrides. */
const INTEGRATION_KEYS: readonly string[] = Object.values(INTEGRATION_CONFIG_KEYS).flatMap((keys) => Object.values(keys));

/**
 * The server's integrations config layer (restapi spec 11.1): what an administrator set in the console's Integrations, held in the nconf layer directly below
 * the plugin settings (`INTEGRATIONS_STORE`). It is rebuilt from the `IntegrationSettings` row on start and on every change notice (`IntegrationsSync`), with
 * restapi's `buildIntegrationsConfigLayer()`, and is where the plaintext of the Giphy key and the registry tokens is kept for the life of the process
 * (spec 5.4): decrypted when the row changes, never per request. Everything that must follow a change reads it at use time through `HostConfig`.
 *
 * A secret that can't be decrypted is left out, so the deployment's value applies; it is warned about once, by its row field and never its value, and
 * remembered in `UnreadableSecrets` so the console can show "Set, but can't be read: enter it again" without decrypting for the request.
 */
export class IntegrationsLayer {
    /** The layer this process runs on, for the code that has no other way to reach it (the Integrations route's view of the deployment's own values). */
    public static active?: IntegrationsLayer;

    private heldVersion?: number;
    private heldUnreadable: string[] = [];
    private readonly warned: Set<string> = new Set();

    /**
     * @param config The server's configuration, which must have the integrations layer (`config.mongo.ts`/`config.sql.ts` add it directly below the plugin
     * settings; one added later would lose to the environment, so it is never added here).
     * @param cipher Decrypts the row's secrets: restapi's cipher over the keyring, with no datastore (the plugin host's).
     * @param logger Where an unreadable secret is warned about.
     */
    constructor(
        private readonly config: IntegrationsLayerConfig,
        private readonly cipher: Pick<ConfigCipher, "decryptString">,
        private readonly logger?: { warn(message: string): void },
    ) {
        if (!this.store) {
            throw new Error(`The configuration has no integrations layer ('${INTEGRATIONS_STORE}'), so what an administrator sets in the console's Integrations has nowhere to go.`);
        }
    }

    private get store(): any {
        return this.config.stores?.[INTEGRATIONS_STORE];
    }

    /** The version of the row the layer was last built from (0 for none saved), or `undefined` before the first. */
    public get version(): number | undefined {
        return this.heldVersion;
    }

    /** The row fields whose secret could not be read when the layer was last built. */
    public get unreadable(): readonly string[] {
        return this.heldUnreadable;
    }

    /**
     * The deployment's own value of every key the Integrations override, flat: what the configuration says without this layer. It is what the console shows as
     * the default a field resets to, and what `buildIntegrationsConfigLayer()` needs to keep the deployment's registry credentials with the deployment's
     * registry. A key nothing configures is not in it.
     */
    public deploymentConfig(): Record<string, unknown> {
        const stores: [string, any][] = Object.entries(this.config.stores ?? {}).filter(([name]) => name !== INTEGRATIONS_STORE);
        const values: Record<string, unknown> = {};
        for (const key of INTEGRATION_KEYS) {
            for (const [, store] of stores) {
                const value: unknown = store.get(key);
                if (value !== undefined) {
                    values[key] = value;
                    break;
                }
            }
        }
        return values;
    }

    /**
     * Rebuilds the layer from `settings` (none before an administrator changed anything): the keys the administrator set replace the layer's, so a field that
     * was reset is the deployment's again. Synchronous, so nothing reads the layer half built. When the row can't be applied (a failure that isn't about a
     * secret is a bug) the layer is left as it was.
     */
    public apply(settings: IntegrationSettings | undefined): IntegrationsLayerResult {
        const { values, unreadable } = buildIntegrationsConfigLayer(settings, this.tracking(), this.deploymentConfig());
        const store = this.store;
        // nconf makes a literal store read-only, which is right for everything but writing this one.
        store.readOnly = false;
        try {
            store.reset();
            for (const [key, value] of Object.entries(values)) {
                store.set(key, value);
            }
        } finally {
            store.readOnly = true;
        }
        this.heldVersion = settings?.version ?? 0;
        this.heldUnreadable = unreadable;
        this.warnAbout(unreadable);
        return { version: this.heldVersion, unreadable };
    }

    /** The cipher, noting in `UnreadableSecrets` which secrets could not be read and which can now. */
    private tracking(): Pick<ConfigCipher, "decryptString"> {
        return {
            decryptString: (envelope: ConfigEnvelope, context: ConfigCipherContext): string => {
                try {
                    const value: string = this.cipher.decryptString(envelope, context);
                    UnreadableSecrets.clear(context);
                    return value;
                } catch (err) {
                    if (err instanceof ConfigSecretUnavailableError) {
                        UnreadableSecrets.record(context, envelope);
                    }
                    throw err;
                }
            },
        };
    }

    /** One warning per field, not one per rebuild; a field that reads again is warned about afresh if it fails again. */
    private warnAbout(unreadable: readonly string[]): void {
        for (const field of [...this.warned]) {
            if (!unreadable.includes(field)) {
                this.warned.delete(field);
            }
        }
        for (const field of unreadable) {
            if (!this.warned.has(field)) {
                this.warned.add(field);
                this.logger?.warn(
                    `The integration secret ${field} is set but can't be read (its key isn't in the configuration keyring), so it was left out and the deployment's value applies: enter it again in the admin console.`,
                );
            }
        }
    }
}
