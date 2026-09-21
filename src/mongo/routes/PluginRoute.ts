///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
import { PluginRouteMongo } from "@rapidmx/restapi/mongo";
import { RouteDecorators } from "@rapidrest/service-core";
import { withPluginPurge } from "../../routes/PluginPurgeRoutes.js";
import { PluginPurgeMongo } from "../PluginPurgeMongo.js";

const { ApiRoute } = RouteDecorators;

// Trusted-role only (enforced by the base route). Records which plugins this deployment runs; each server copy's
// plugin host (src/plugins/PluginHost.ts) installs them and restarts to apply changes. Uninstalling can also delete the
// plugin's data (`DELETE /:id` with `{ "purgeData": true }`) - see routes/PluginPurgeRoutes.ts.
@ApiRoute("system/plugins")
export class PluginRoute extends withPluginPurge(PluginRouteMongo, { datastore: "mongo", purgeClass: PluginPurgeMongo }) {}
