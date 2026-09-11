///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
import { KeyVaultRouteMongo } from "@rapidmx/restapi/mongo";
import { RouteDecorators } from "@rapidrest/service-core";

const { ApiRoute } = RouteDecorators;

// Shares its base path with MailboxRoute.ts - this class only contributes the `/:id/keyvault*` methods
// BaseKeyVaultRoute declares, layered onto the same `mail/mailboxes` prefix.
@ApiRoute("mail/mailboxes")
export class KeyVaultRoute extends KeyVaultRouteMongo {}
