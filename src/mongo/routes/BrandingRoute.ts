///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
import { BrandingRouteMongo } from "@rapidmx/restapi/mongo";
import { RouteDecorators } from "@rapidrest/service-core";

const { ApiRoute } = RouteDecorators;

// Deployment-wide settings live under system/.
@ApiRoute("system/branding")
export class BrandingRoute extends BrandingRouteMongo {}
