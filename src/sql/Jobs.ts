////////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
////////////////////////////////////////////////////////////////////////////////

// The following re-exports needed job classes so that they are properly picked up by
// the ClassLoader (and ObjectFactory) during server startup
export {
    AcmeEnrollmentDriverJobSQL,
    AttachmentExtractionJobSQL,
    CalendarReminderJobSQL,
    DomainVerificationJobSQL,
    EasDeviceStateCleanupJobSQL,
    ExternalShareExpirationJobSQL,
    MailboxQuotaRecalcJobSQL,
    MeetingSchedulingJobSQL,
    QuarantineRetentionJobSQL,
    ScanQueueJobSQL,
    SearchIndexJobSQL,
} from "@rapidmx/restapi/sql";
