///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
import { MatterRouteSQL } from "@rapidmx/restapi/sql";
import { RouteDecorators } from "@rapidrest/service-core";

const { ApiRoute } = RouteDecorators;

// Holder-gated, not admin-gated (see BaseMatterRoute's own doc comment) - a trusted admin who isn't a
// holder of a Matter's own escrow scope gets the same 403 as anyone else.
@ApiRoute("escrow/matters")
export class MatterRoute extends MatterRouteSQL {}
