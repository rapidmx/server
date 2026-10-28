///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
import { IntegrationsRouteMongo } from "@rapidmx/restapi/mongo";
import { RouteDecorators } from "@rapidrest/service-core";

const { ApiRoute } = RouteDecorators;

// The admin console's Integrations settings (Giphy, STUN, the signing CA, the DNS resolver, the plugin registry):
// typed, audited, with the deployment's configuration as the default each field resets to. Secrets are encrypted in
// the row and shown as masks. Reads need a trusted role; writes need an elevated token too.
@ApiRoute("system/integrations")
export class IntegrationsRoute extends IntegrationsRouteMongo {}
