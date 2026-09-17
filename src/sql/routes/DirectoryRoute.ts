///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
import { DirectoryRouteSQL } from "@rapidmx/restapi/sql";
import { RouteDecorators } from "@rapidrest/service-core";

const { ApiRoute } = RouteDecorators;

// Recipient suggestions for compose: GET /api/mail/directory (this server's mailboxes and distribution lists) and
// GET /api/mail/directory/contacts (the caller's contacts) - see restapi's BaseDirectoryRoute.
@ApiRoute("mail/directory")
export class DirectoryRoute extends DirectoryRouteSQL {}
