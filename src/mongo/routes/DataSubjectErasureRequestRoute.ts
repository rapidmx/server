///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
import { DataSubjectErasureRequestRouteMongo } from "@rapidmx/restapi/mongo";
import { RouteDecorators } from "@rapidrest/service-core";

const { ApiRoute } = RouteDecorators;

// create() is self-service only - no admin-on-behalf-of path, unlike DataExportRequestRoute/
// MailboxImportRequestRoute - always the caller's own mailbox. approve()/deny() are
// @RequiresTrustedRole()-only; approve() 409s if the mailbox is on an active legal hold
// (ErasureExecutionJob re-checks this again immediately before the actual destructive cascade).
@ApiRoute("mail/erasure-requests")
export class DataSubjectErasureRequestRoute extends DataSubjectErasureRequestRouteMongo {}
