///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
import { AttachmentSQL, EncryptionPolicySQL, FolderSQL, MailboxSQL, MatterSQL, MessageSQL, ZeroAccessIndexEntrySQL } from "@rapidmx/restapi/sql";
import { RouteDecorators } from "@rapidrest/service-core";
import { BaseMailComposeRoute } from "../../routes/BaseMailComposeRoute.js";

const { ApiRoute } = RouteDecorators;

@ApiRoute("mail/compose")
export class MailComposeRoute extends BaseMailComposeRoute<MessageSQL, AttachmentSQL, MailboxSQL, FolderSQL> {
    protected messageClass: any = MessageSQL;
    protected attachmentClass: any = AttachmentSQL;
    protected mailboxClass: any = MailboxSQL;
    protected folderClass: any = FolderSQL;
    protected matterClass: any = MatterSQL;
    protected encryptionPolicyClass: any = EncryptionPolicySQL;
    protected zeroAccessIndexEntryClass: any = ZeroAccessIndexEntrySQL;
}
