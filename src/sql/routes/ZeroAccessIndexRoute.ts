///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
import { ZeroAccessIndexRouteSQL } from "@rapidmx/restapi/sql";
import { RouteDecorators } from "@rapidrest/service-core";

const { ApiRoute } = RouteDecorators;

// Shares its base path with MailboxRoute.ts - this class only contributes the `/:id/search-index*` methods
// BaseZeroAccessIndexRoute declares (the zero-access search index), layered onto the same `mail/mailboxes` prefix.
@ApiRoute("mail/mailboxes")
export class ZeroAccessIndexRoute extends ZeroAccessIndexRouteSQL {}
