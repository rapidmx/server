///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
import { EscrowAuditLogRouteSQL } from "@rapidmx/restapi/sql";
import { RouteDecorators } from "@rapidrest/service-core";

const { ApiRoute } = RouteDecorators;

// find/count/findById are auto-scoped per caller (trusted admin sees everything, a holder sees only
// matters under scopes they hold, anyone else sees nothing); GET /verify is @RequiresTrustedRole() only
// (the chain is global, not per-scope, so brokenAtSequence would leak other scopes' activity volume);
// create/update/delete/truncate are unconditionally rejected for every caller - the only writer is
// restapi's own internal recordEscrowAuditEntry(), which bypasses this route entirely.
@ApiRoute("escrow/audit-log")
export class EscrowAuditLogRoute extends EscrowAuditLogRouteSQL {}
