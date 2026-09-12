///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
import { MatterExportRequestRouteSQL } from "@rapidmx/restapi/sql";
import { RouteDecorators } from "@rapidrest/service-core";

const { ApiRoute } = RouteDecorators;

// Holder-gated throughout (requireEscrowHolder() against the matter's own escrowScopeId) - no
// dual-control approval, unlike EscrowAccessRequest. Its own top-level collection, not nested under
// escrow/matters/:id/export, matching every other async-request resource in this batch.
@ApiRoute("escrow/matter-export-requests")
export class MatterExportRequestRoute extends MatterExportRequestRouteSQL {}
