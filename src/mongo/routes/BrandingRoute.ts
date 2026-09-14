///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
import { BrandingRouteMongo } from "@rapidmx/restapi/mongo";
import { RouteDecorators } from "@rapidrest/service-core";

const { ApiRoute } = RouteDecorators;

// Deployment-wide settings live under system/. mail/branding stays mounted too: logo, icon and stylesheet URLs
// uploaded before the move were saved with that path (see mail:branding:public_url).
@ApiRoute(["system/branding", "mail/branding"])
export class BrandingRoute extends BrandingRouteMongo {}
