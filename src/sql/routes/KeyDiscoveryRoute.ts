///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
import { KeyDiscoveryRouteSQL } from "@rapidmx/restapi/sql";
import { RouteDecorators } from "@rapidrest/service-core";

const { Route } = RouteDecorators;

// Deliberately mounted outside of `/api` and unauthenticated - this is the public federation discovery
// endpoint (specs/end-to-end_encryption.md's "Public Endpoint"), fetched by other RapidMX servers over
// plain HTTPS with no session/JWT of their own. `@RateLimit()` and the not-found/no-keys response shape
// are handled inside BaseKeyDiscoveryRoute itself.
@Route("/.well-known/rapidmx/keys")
export class KeyDiscoveryRoute extends KeyDiscoveryRouteSQL {}
