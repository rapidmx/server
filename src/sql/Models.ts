////////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
////////////////////////////////////////////////////////////////////////////////

// The following re-exports needed model classes so that they are properly picked up by
// the ClassLoader (and ObjectFactory) during server startup
export {
    AttachmentSQL,
    CalendarEventSQL,
    CalendarShareLinkSQL,
    ContactListSQL,
    ContactSQL,
    FolderSQL,
    IngestQueueEntrySQL,
    MailboxSQL,
    MessageSQL,
    NoteSQL,
    PluginSQL,
    QuarantineEntrySQL,
    ScanResultSQL,
    SearchIndexStateSQL,
    TaskListSQL,
    TaskSQL,
} from "@rapidmx/restapi/sql";
