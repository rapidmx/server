///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
import { MailboxPolicyRouteMongo } from "@rapidmx/restapi/mongo";
import { RouteDecorators } from "@rapidrest/service-core";

const { ApiRoute } = RouteDecorators;

// GET is any-authenticated-user readable; PUT is @RequiresTrustedRole()-only. Seeded from mail:default_quota_bytes and
// mail:auto_provision:* on first use, which stay the fallback for anything the saved policy leaves unset.
@ApiRoute("system/mailbox-policy")
export class MailboxPolicyRoute extends MailboxPolicyRouteMongo {}
