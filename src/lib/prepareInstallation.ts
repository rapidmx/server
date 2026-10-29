///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { applyIntegrations } from "../integrations/startIntegrations.js";
import type { IntegrationsLayer } from "../integrations/IntegrationsLayer.js";
import type { BootstrapLogger } from "../dns/BootstrapDnsProvider.js";
import { seedInstallation, type InstallationClasses, type InstallationFactory, type InstallationSeeded } from "./seedInstallation.js";

/**
 * What a server does after its datastores are connected and before it listens (`InstallationServer`'s step): first the Integrations an administrator chose in the
 * console are applied to the layer (so the DNSSEC resolver, the signing CA and the rest are in force from the first request (a cron tick before this step, while service-core starts its background services, still reads the deployment's values),
 * not only once `startIntegrationsSync()` has run after the server listens), then the installation's own setup (`seedInstallation()`). Never throws.
 *
 * @param objectFactory The server's `ObjectFactory`.
 * @param config The runtime configuration.
 * @param logger Where the outcome is said.
 * @param classes The datastore's classes.
 * @param integrations The layer from `prepareIntegrations()` and the datastore's `IntegrationSettingsMongo`/`IntegrationSettingsSQL`.
 */
export async function prepareInstallation(
    objectFactory: InstallationFactory,
    config: { get(key: string): unknown },
    logger: BootstrapLogger,
    classes: InstallationClasses,
    integrations: { layer: IntegrationsLayer; settingsClass: { name: string } },
): Promise<InstallationSeeded> {
    await applyIntegrations(objectFactory, integrations.layer, integrations.settingsClass, logger);
    return seedInstallation(objectFactory, config, logger, classes);
}
