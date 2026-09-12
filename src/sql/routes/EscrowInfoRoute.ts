///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
import { EscrowScopeSQL, MailboxSQL } from "@rapidmx/restapi/sql";
import { RouteDecorators } from "@rapidrest/service-core";
import { BaseEscrowInfoRoute } from "../../routes/BaseEscrowInfoRoute.js";

const { ApiRoute } = RouteDecorators;

// Shares its base path with MailboxRoute.ts/KeyVaultRoute.ts - this class only contributes the
// `/:id/escrow-info` method BaseEscrowInfoRoute declares, layered onto the same `mail/mailboxes` prefix.
@ApiRoute("mail/mailboxes")
export class EscrowInfoRoute extends BaseEscrowInfoRoute<MailboxSQL> {
    protected mailboxClass: any = MailboxSQL;
    protected escrowScopeClass: any = EscrowScopeSQL;
}
