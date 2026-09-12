///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
import { EscrowScopeRouteMongo } from "@rapidmx/restapi/mongo";
import { RouteDecorators } from "@rapidrest/service-core";

const { ApiRoute } = RouteDecorators;

// Trusted-admin-only for every action (create/update/delete/find/count/findById) - see
// BaseEscrowScopeRoute's own doc comment: configuring who counts as a holder is an administrative act,
// deliberately separate from actually holding the eDiscovery/compliance role (see MatterRoute.ts).
@ApiRoute("escrow/scopes")
export class EscrowScopeRoute extends EscrowScopeRouteMongo {}
