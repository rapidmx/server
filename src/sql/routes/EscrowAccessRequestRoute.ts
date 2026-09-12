///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
import { EscrowAccessRequestRouteSQL } from "@rapidmx/restapi/sql";
import { RouteDecorators } from "@rapidrest/service-core";

const { ApiRoute } = RouteDecorators;

// Holder-gated on every action, same as MatterRoute - no @RequiresTrustedRole() anywhere in the base
// class, so a trusted admin with no holder grant on the relevant scope gets 403 same as anyone else.
@ApiRoute("escrow/access-requests")
export class EscrowAccessRequestRoute extends EscrowAccessRequestRouteSQL {}
