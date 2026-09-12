////////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
////////////////////////////////////////////////////////////////////////////////

// The following re-exports needed job classes so that they are properly picked up by
// the ClassLoader (and ObjectFactory) during server startup
export {
    AcmeEnrollmentDriverJobMongo,
    AttachmentExtractionJobMongo,
    CalendarReminderJobMongo,
    DataExportJobMongo,
    DomainVerificationJobMongo,
    EasDeviceStateCleanupJobMongo,
    ExternalShareExpirationJobMongo,
    MailboxQuotaRecalcJobMongo,
    MeetingSchedulingJobMongo,
    QuarantineRetentionJobMongo,
    RetentionEnforcementJobMongo,
    ScanQueueJobMongo,
    SearchIndexJobMongo,
} from "@rapidmx/restapi/mongo";
