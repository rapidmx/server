////////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
////////////////////////////////////////////////////////////////////////////////

// Re-exports every @rapidmx/restapi model class so the ClassLoader (and ObjectFactory) picks it up during server
// startup. The ConnectionManager only connects models the ClassLoader found: a model missing here has no SQL entity
// (every query on it fails) and no Mongo indexes. This must be the complete list - test/Models.test.ts compares it
// with every model class @rapidmx/restapi/mongo exports, so a model added there fails the suite until it's added here.
// (Not `export *`: that entry point also exports restapi's routes and jobs, which this server mounts selectively.)
export {
    AppearancePreferencesMongo,
    AttachmentMongo,
    AuditLogEntryMongo,
    BrandingMongo,
    CalendarEventAttendeeLinkMongo,
    CalendarEventMongo,
    CalendarShareLinkMongo,
    ContactListMongo,
    ContactMongo,
    DataExportRequestMongo,
    DataSubjectErasureRequestMongo,
    DistributionListMongo,
    DomainMongo,
    EncryptionPolicyMongo,
    EscrowAccessRequestMongo,
    EscrowAuditHeadMongo,
    EscrowAuditLogEntryMongo,
    EscrowScopeMongo,
    FocusedInboxOverrideMongo,
    FolderMongo,
    IngestQueueEntryMongo,
    KeyVaultMongo,
    LabelMongo,
    MailFilterRuleMongo,
    MailSignatureMongo,
    MailboxImportRequestMongo,
    MailboxMongo,
    MailboxPolicyMongo,
    MatterExportRequestMongo,
    MatterMongo,
    MessageMongo,
    NoteMongo,
    OofReplySuppressionMongo,
    PluginMongo,
    QuarantineEntryMongo,
    RetentionPolicyMongo,
    ScanResultMongo,
    SearchIndexStateMongo,
    SetupStateMongo,
    TaskListMongo,
    TaskMongo,
    TransportRuleMongo,
} from "@rapidmx/restapi/mongo";
