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
    EasDeviceStateCleanupJobSQL,
    ExternalShareExpirationJobSQL,
    MailboxImportJobSQL,
    MailboxQuotaRecalcJobSQL,
    MeetingSchedulingJobSQL,
    QuarantineRetentionJobSQL,
    RetentionEnforcementJobSQL,
    ScanQueueJobSQL,
    SearchIndexJobSQL,
} from "@rapidmx/restapi/sql";
