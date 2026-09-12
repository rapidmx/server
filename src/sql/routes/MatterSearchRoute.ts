///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
import { MatterSearchRouteSQL } from "@rapidmx/restapi/sql";
import { RouteDecorators } from "@rapidrest/service-core";

const { ApiRoute } = RouteDecorators;

// A single GET, query-param driven (matterId required) - holder-gated against the matter's own
// escrowScopeId. before/after are always clamped to the matter's own date range server-side, regardless
// of what's supplied. Mounted at its own path since BaseMatterRoute already owns escrow/matters.
@ApiRoute("escrow/matter-search")
export class MatterSearchRoute extends MatterSearchRouteSQL {}
