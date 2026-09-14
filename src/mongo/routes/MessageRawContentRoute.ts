///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
import { AuditLogEntryMongo, MailboxMongo, MessageMongo } from "@rapidmx/restapi/mongo";
import { RouteDecorators } from "@rapidrest/service-core";
import { BaseMessageRawContentRoute } from "../../routes/BaseMessageRawContentRoute.js";

const { ApiRoute } = RouteDecorators;

@ApiRoute("mail/messages")
export class MessageRawContentRoute extends BaseMessageRawContentRoute<MessageMongo> {
    protected messageClass: any = MessageMongo;
    protected mailboxClass: any = MailboxMongo;
    protected auditLogClass: any = AuditLogEntryMongo;
}
