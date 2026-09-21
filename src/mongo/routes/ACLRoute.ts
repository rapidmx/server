///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
import { AccessControlListMongo, RouteDecorators } from "@rapidrest/service-core";
import { BaseGuardedACLRoute } from "../../routes/BaseGuardedACLRoute.js";

const { ApiRoute, Model } = RouteDecorators;

// The mechanism for granting/revoking a mailbox's shared/delegate access (Exchange-style shared mailboxes) —
// see @rapidmx/restapi's BaseMailboxRoute doc comment. Generic, not mail-specific: any ACL-protected entity's
// access can be managed through this same route - except that a trusted role (an administrator) no longer reaches the
// ACLs that govern anybody's mail: see `BaseGuardedACLRoute`.
@Model(AccessControlListMongo)
@ApiRoute("acls")
export class ACLRoute extends BaseGuardedACLRoute<AccessControlListMongo> {}
