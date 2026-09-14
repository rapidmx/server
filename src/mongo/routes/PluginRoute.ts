///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
import { PluginRouteMongo } from "@rapidmx/restapi/mongo";
import { RouteDecorators } from "@rapidrest/service-core";

const { ApiRoute } = RouteDecorators;

// Trusted-role only (enforced by the base route). Records which plugins this deployment runs; each server copy's
// plugin host (src/plugins/PluginHost.ts) installs them and restarts to apply changes.
@ApiRoute("system/plugins")
export class PluginRoute extends PluginRouteMongo {}
