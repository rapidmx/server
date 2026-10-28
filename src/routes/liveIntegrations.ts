///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ObjectDecorators } from "@rapidrest/core";
import type { ConfigCipher, IntegrationSettings, IntegrationSettingsResponse } from "@rapidmx/restapi";
import type { IntegrationsChannel } from "../integrations/IntegrationsChannel.js";
import { IntegrationsLayer } from "../integrations/IntegrationsLayer.js";
import { markUnreadableIntegrations } from "../secrets/markUnreadableIntegrations.js";

const { Inject } = ObjectDecorators;

/** What the mixin uses of restapi's `BaseIntegrationsRoute` (both datastores' routes have it): its private `view()` is overridden at run time, as `toPublic()` is for DNS providers. */
interface IntegrationsRouteBase {
    cipher?: Pick<ConfigCipher, "loadedKids">;
    deploymentConfig(): Record<string, unknown>;
    integrationsChanged(settings: IntegrationSettings): Promise<void>;
    view(settings: IntegrationSettings | undefined): IntegrationSettingsResponse;
}

export type IntegrationsRouteConstructor = new (...args: any[]) => IntegrationsRouteBase;

/**
 * Makes restapi's Integrations route (`system/integrations`) the server's, for one datastore (restapi spec 10.2, 11.2):
 *
 * - A saved change is announced to every server copy (`integrationsChanged()`), which publishes the row's new version on the `IntegrationsChannel`
 * (`rapidmx:integrations:changed`); each copy's `IntegrationsSync` then rebuilds its integrations layer.
 * - The `defaults` the console shows (`deploymentConfig()`) are the deployment's own values, read from the configuration without the integrations layer;
 * restapi's route reads them from `@Config` values, which are taken when the route is built, after the server has put the layer in the configuration.
 * - A secret this process couldn't read is marked `unreadable: true` in the view, from what has already been tried, never by decrypting for the request.
 */
export function withLiveIntegrations<B extends IntegrationsRouteConstructor>(Base: B) {
    class LiveIntegrationsRoute extends Base {
        /** Announces a saved change. Registered by `registerCoreProviders()`: Redis for the server copies, the process's own where there is only one. */
        @Inject("IntegrationsChannel")
        public channel?: IntegrationsChannel;

        public deploymentConfig(): Record<string, unknown> {
            return IntegrationsLayer.active?.deploymentConfig() ?? super.deploymentConfig();
        }

        public async integrationsChanged(settings: IntegrationSettings): Promise<void> {
            await this.channel?.publish(settings.version);
        }

        public view(settings: IntegrationSettings | undefined): IntegrationSettingsResponse {
            return markUnreadableIntegrations(super.view(settings), settings, this.cipher);
        }
    }
    return LiveIntegrationsRoute;
}
