///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
import { BrandingRouteSQL } from "@rapidmx/restapi/sql";
import { RouteDecorators } from "@rapidrest/service-core";

const { ApiRoute } = RouteDecorators;

// Deployment-wide settings live under system/.
@ApiRoute("system/branding")
export class BrandingRoute extends BrandingRouteSQL {}
