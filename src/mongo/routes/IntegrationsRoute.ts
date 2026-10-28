///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
import { IntegrationsRouteMongo as RestapiIntegrationsRoute } from "@rapidmx/restapi/mongo";
import { RouteDecorators } from "@rapidrest/service-core";
import { withLiveIntegrations, type IntegrationsRouteConstructor } from "../../routes/liveIntegrations.js";

const { ApiRoute } = RouteDecorators;

// The admin console's Integrations settings (Giphy, STUN, the signing CA, the DNS resolver, the plugin registry):
// typed, audited, with the deployment's configuration as the default each field resets to. Secrets are encrypted in
// the row and shown as masks. Reads need a trusted role; writes need an elevated token too. A saved change is announced
// to every server copy to rebuild its integrations layer (src/integrations/), and a secret this process couldn't read
// is marked in the view so the console can ask for it again.
@ApiRoute("system/integrations")
export class IntegrationsRoute extends withLiveIntegrations(RestapiIntegrationsRoute as unknown as IntegrationsRouteConstructor) {}
