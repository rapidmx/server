///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
import { KeyLookupRouteMongo } from "@rapidmx/restapi/mongo";
import { RouteDecorators } from "@rapidrest/service-core";

const { ApiRoute } = RouteDecorators;

// Shares its base path with MailboxRoute.ts - this class only contributes the `/:id/keys/lookup` method
// BaseKeyLookupRoute declares, layered onto the same `mail/mailboxes` prefix.
@ApiRoute("mail/mailboxes")
export class KeyLookupRoute extends KeyLookupRouteMongo {}
