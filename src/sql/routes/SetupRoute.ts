///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
import { SetupRouteSQL } from "@rapidmx/restapi/sql";
import { RouteDecorators } from "@rapidrest/service-core";

const { ApiRoute } = RouteDecorators;

// Trusted-role only. The admin console's first-run setup wizard state; the web apps redirect admins to the wizard while
// it reports setup as required.
@ApiRoute("system/setup")
export class SetupRoute extends SetupRouteSQL {}
