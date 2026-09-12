///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
import { DataExportRequestRouteSQL } from "@rapidmx/restapi/sql";
import { RouteDecorators } from "@rapidrest/service-core";

const { ApiRoute } = RouteDecorators;

// create() is both self-service (own mailbox only) and admin-mediated (a trusted caller may supply an
// explicit mailboxUid) - see BaseDataExportRoute's own doc comment. find()/findById()/download() are
// hand-scoped to "the requester, the mailbox's own owner, or a trusted admin", not the generic ACL system.
@ApiRoute("mail/data-export-requests")
export class DataExportRequestRoute extends DataExportRequestRouteSQL {}
