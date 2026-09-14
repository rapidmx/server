////////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
////////////////////////////////////////////////////////////////////////////////

// The following re-exports needed model classes so that they are properly picked up by
// the ClassLoader (and ObjectFactory) during server startup
export {
    AttachmentMongo,
    CalendarEventMongo,
    CalendarShareLinkMongo,
    ContactListMongo,
    ContactMongo,
    FolderMongo,
    IngestQueueEntryMongo,
    MailboxMongo,
    MessageMongo,
    NoteMongo,
    PluginMongo,
    QuarantineEntryMongo,
    ScanResultMongo,
    SearchIndexStateMongo,
    TaskListMongo,
    TaskMongo,
} from "@rapidmx/restapi/mongo";
