////////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
////////////////////////////////////////////////////////////////////////////////

// The following re-exports needed job classes so that they are properly picked up by
// the ClassLoader (and ObjectFactory) during server startup
export {
    AcmeEnrollmentDriverJobSQL,
    AttachmentExtractionJobSQL,
    CalendarReminderJobSQL,
    DataExportJobSQL,
    DomainVerificationJobSQL,
    ErasureExecutionJobSQL,
    ExternalShareExpirationJobSQL,
    MailboxImportJobSQL,
    MailboxQuotaRecalcJobSQL,
    MatterExportJobSQL,
    MeetingSchedulingJobSQL,
    OofReplySuppressionCleanupJobSQL,
    QuarantineRetentionJobSQL,
    RetentionEnforcementJobSQL,
    ScanQueueJobSQL,
    ScheduledSendJobSQL,
    SearchIndexJobSQL,
} from "@rapidmx/restapi/sql";
