///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { HostConfig, INTEGRATION_SETTINGS_UID, type ConfigCipher, type IntegrationSettings } from "@rapidmx/restapi";
import { RepoUtils } from "@rapidrest/service-core";
import type { IntegrationsChannel } from "./IntegrationsChannel.js";
import { IntegrationsLayer, type IntegrationsLayerConfig } from "./IntegrationsLayer.js";
import { IntegrationsSync } from "./IntegrationsSync.js";

/** What `prepareIntegrations()` set up, to be stopped with the server. */
export interface PreparedIntegrations {
    layer: IntegrationsLayer;
    /** Removes the configuration `HostConfig` reads and forgets the layer. */
    stop(): void;
}

/**
 * Builds the integrations layer and installs the server's configuration for `HostConfig` (restapi spec 11.1). Run first in a server process, before any plugin
 * loads, so code that reads a value at use time sees the layer from the start. The layer is empty until `startIntegrationsSync()` builds it from the row once
 * the datastores are connected: the plugin host, which runs before that, installs from the deployment's registry (the row's registry fields are plain, and a
 * database writer must not be able to move where this server's code is installed from).
 *
 * @param config The server's `nconf` instance, which has the integrations layer.
 * @param cipher Restapi's cipher over the keyring, with no datastore: nothing is connected yet.
 * @param logger Where an unreadable secret is warned about.
 * @throws If a configuration is installed already (`HostConfig` takes one, once), or there is no integrations layer.
 */
export function prepareIntegrations(
    config: IntegrationsLayerConfig & { get(key: string): unknown },
    cipher: Pick<ConfigCipher, "decryptString">,
    logger?: { warn(message: string): void },
): PreparedIntegrations {
    const layer: IntegrationsLayer = new IntegrationsLayer(config, cipher, logger);
    const uninstall: () => void = HostConfig.install(config);
    IntegrationsLayer.active = layer;
    return {
        layer,
        stop: () => {
            uninstall();
            if (IntegrationsLayer.active === layer) {
                IntegrationsLayer.active = undefined;
            }
        },
    };
}

/** The part of the `ObjectFactory` this needs. */
export interface IntegrationsFactory {
    newInstance<T>(type: any, options?: { name?: string; args?: unknown[] }): T | Promise<T>;
}

/** What `startIntegrationsSync()` started. */
export interface RunningIntegrationsSync {
    /** Stops listening and polling, and waits for a refresh in progress. Safe to call again. */
    stop(): Promise<void>;
}

/**
 * Keeps the integrations layer current while the server runs (`IntegrationsSync`, spec 11.2), once its datastores are connected: applies the row now, then on the
 * `rapidmx:integrations:changed` notice and on a timer comparing the row's version. Nothing here can stop the server from starting: a datastore that can't be
 * read leaves the layer as it is, a notice that can't be heard leaves the timer, and a piece that can't be built is logged.
 *
 * @param objectFactory The server's `ObjectFactory`, which builds the row's repository and holds the registered `"IntegrationsChannel"`.
 * @param layer The layer from `prepareIntegrations()`.
 * @param settingsClass The datastore's `IntegrationSettingsMongo` or `IntegrationSettingsSQL`.
 * @param logger Where a failure is said.
 * @param options `pollMs` is for tests.
 */
export async function startIntegrationsSync(
    objectFactory: IntegrationsFactory,
    layer: IntegrationsLayer,
    settingsClass: { name: string },
    logger: { warn(message: string): void; error(message: string): void },
    options: { pollMs?: number } = {},
): Promise<RunningIntegrationsSync> {
    let sync: IntegrationsSync | undefined;
    try {
        const repo: RepoUtils<IntegrationSettings> = await objectFactory.newInstance(RepoUtils, { name: settingsClass.name, args: [settingsClass] });
        let channel: IntegrationsChannel | undefined;
        try {
            channel = await objectFactory.newInstance<IntegrationsChannel>("IntegrationsChannel", { name: "default" });
        } catch (err: any) {
            logger.warn(`The integrations change notice is not available (${err?.message}); this copy follows the integrations on its timer instead.`);
        }
        sync = new IntegrationsSync({
            layer,
            read: async () => (await repo.findOne(INTEGRATION_SETTINGS_UID, { ignoreACL: true, skipCache: true })) ?? undefined,
            channel,
            logger,
            pollMs: options.pollMs,
        });
        await sync.start();
    } catch (err: any) {
        logger.error(`The integrations could not be kept up to date, so changes made in the admin console apply at the next start: ${err?.message}`);
    }
    return { stop: async () => sync?.stop() };
}
