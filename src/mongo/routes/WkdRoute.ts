///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
import { WkdRouteMongo } from "@rapidmx/restapi/mongo";
import { RouteDecorators } from "@rapidrest/service-core";

const { Route } = RouteDecorators;

// The OpenPGP Web Key Directory: public and unauthenticated, outside of `/api`, like the RapidMX discovery endpoint
// (KeyDiscoveryRoute.ts). Answers the direct method on a mail domain served here and the advanced method on the
// `openpgpkey.<domain>` host the Helm chart routes to this server. Rate limiting and the 404s are BaseWkdRoute's.
@Route("/.well-known/openpgpkey")
export class WkdRoute extends WkdRouteMongo {}
