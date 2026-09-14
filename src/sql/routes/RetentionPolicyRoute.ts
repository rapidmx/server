///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
import { RetentionPolicyRouteSQL } from "@rapidmx/restapi/sql";
import { RouteDecorators } from "@rapidrest/service-core";

const { ApiRoute } = RouteDecorators;

// GET is any-authenticated-user readable; PUT is @RequiresTrustedRole()-only (enforced by the base
// route itself, not this file). Enforcement of the configured policy lives entirely in
// RetentionEnforcementJob, not this route - see Jobs.ts.
@ApiRoute("system/retention-policy")
export class RetentionPolicyRoute extends RetentionPolicyRouteSQL {}
