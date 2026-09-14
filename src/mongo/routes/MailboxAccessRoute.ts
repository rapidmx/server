///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
import { MailboxAccessRouteMongo } from "@rapidmx/restapi/mongo";
import { RouteDecorators } from "@rapidrest/service-core";

const { ApiRoute } = RouteDecorators;

// Shares its base path with MailboxRoute.ts - this class only contributes the access-management/email-
// lookup methods BaseMailboxAccessRoute declares, layered onto the same `mail/mailboxes` prefix.
@ApiRoute("mail/mailboxes")
export class MailboxAccessRoute extends MailboxAccessRouteMongo {}
