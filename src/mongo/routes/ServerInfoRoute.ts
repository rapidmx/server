///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
import { ServerInfoRouteMongo } from "@rapidmx/restapi/mongo";
import { RouteDecorators } from "@rapidrest/service-core";

const { Route } = RouteDecorators;

// Deliberately mounted outside of `/api` and unauthenticated - native clients fetch it over plain HTTPS
// after discovering this server's host from DNS, to learn the separate auth-server URL they sign in against.
// `@RateLimit()` and the never-404 response shape are handled inside BaseServerInfoRoute itself.
@Route("/.well-known/rapidmx/server-info")
export class ServerInfoRoute extends ServerInfoRouteMongo {}
