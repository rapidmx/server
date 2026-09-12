///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
import { MailboxImportRequestRouteMongo } from "@rapidmx/restapi/mongo";
import { RouteDecorators } from "@rapidrest/service-core";

const { ApiRoute } = RouteDecorators;

// create() takes the uploaded file's raw bytes as the request body (req.rawBody), with
// format/targetFolderUid/mailboxUid as query-string params - not a JSON body. Both self-service (own
// mailbox only) and admin-mediated (a trusted caller may supply an explicit mailboxUid), same idiom as
// DataExportRequestRoute.
@ApiRoute("mail/mailbox-import-requests")
export class MailboxImportRequestRoute extends MailboxImportRequestRouteMongo {}
