////////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
////////////////////////////////////////////////////////////////////////////////

// Re-exports every @rapidmx/restapi model class so the ClassLoader (and ObjectFactory) picks it up during server
// startup. The ConnectionManager only connects models the ClassLoader found: a model missing here has no SQL entity
// (every query on it fails) and no Mongo indexes. This must be the complete list - test/Models.test.ts compares it
// with every model class @rapidmx/restapi/sql exports, so a model added there fails the suite until it's added here.
// (Not `export *`: that entry point also exports restapi's routes and jobs, which this server mounts selectively.)
export {
    AttachmentSQL,
    AuditLogEntrySQL,
    BrandingSQL,
    CalendarEventSQL,
    CalendarShareLinkSQL,
    ContactListSQL,
    ContactSQL,
    DataExportRequestSQL,
    DataSubjectErasureRequestSQL,
    DistributionListSQL,
    DomainSQL,
    EncryptionPolicySQL,
    EscrowAccessRequestSQL,
    EscrowAuditHeadSQL,
    EscrowAuditLogEntrySQL,
    EscrowScopeSQL,
    FocusedInboxOverrideSQL,
    FolderSQL,
    IngestQueueEntrySQL,
    KeyVaultSQL,
    LabelSQL,
    MailFilterRuleSQL,
    MailSignatureSQL,
    MailboxImportRequestSQL,
    MailboxPolicySQL,
    MailboxSQL,
    MatterExportRequestSQL,
    MatterSQL,
    MessageSQL,
    NoteSQL,
    OofReplySuppressionSQL,
    PluginSQL,
    QuarantineEntrySQL,
    RetentionPolicySQL,
    ScanResultSQL,
    SearchIndexStateSQL,
    SetupStateSQL,
    TaskListSQL,
    TaskSQL,
    TransportRuleSQL,
} from "@rapidmx/restapi/sql";
