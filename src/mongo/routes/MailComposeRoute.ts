///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
import { AttachmentMongo, FolderMongo, MailboxMongo, MatterMongo, MessageMongo } from "@rapidmx/restapi/mongo";
import { RouteDecorators } from "@rapidrest/service-core";
import { BaseMailComposeRoute } from "../../routes/BaseMailComposeRoute.js";

const { ApiRoute } = RouteDecorators;

@ApiRoute("mail/compose")
export class MailComposeRoute extends BaseMailComposeRoute<MessageMongo, AttachmentMongo, MailboxMongo, FolderMongo> {
    protected messageClass: any = MessageMongo;
    protected attachmentClass: any = AttachmentMongo;
    protected mailboxClass: any = MailboxMongo;
    protected folderClass: any = FolderMongo;
    protected matterClass: any = MatterMongo;
}
