///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
// The server's half of the route audit behind "no role reads another user's mail" (`@rapidmx/restapi`'s
// `test/routes/mailAccessRouteTable.ts` is the other half): every route class the server mounts is either one of
// restapi's (classified there, and put through its access matrix), or one of the server's own, classified here; and no
// route calls `ACLUtils.hasPermission()` directly - it treats a trusted role as a superuser, so mailbox-scoped code asks
// `hasMailAccess()` instead.
import * as fs from "fs";
import * as path from "path";

const SRC = path.resolve(__dirname, "../../src");

/** Route classes that are restapi's own, mounted here by a subclass that adds only a path and model classes. */
const RESTAPI_ROUTES = new Set([
    "AppearanceRoute", "AttachmentRoute", "AuditLogRoute", "BrandingRoute", "CalendarEventRoute", "CalendarShareLinkRoute",
    "ContactListRoute", "ContactRoute", "DataExportRequestRoute", "DataSubjectErasureRequestRoute", "DirectoryRoute",
    "DistributionListRoute", "DomainRoute", "EncryptionPolicyRoute", "EscrowAccessRequestRoute", "EscrowAuditLogRoute",
    "EscrowScopeRoute", "FocusedInboxOverrideRoute", "FolderRoute", "IngestQueueRoute", "KeyDiscoveryRoute", "KeyLookupRoute",
    "KeyVaultRoute", "LabelRoute", "MailFilterRuleRoute", "MailIngestRoute", "MailSignatureRoute", "MailboxAccessRoute",
    "MailboxImportRequestRoute", "MailboxPolicyRoute", "MailboxRoute", "MatterExportRequestRoute", "MatterRoute",
    "MatterSearchRoute", "MessageRoute", "NoteRoute", "PluginRoute", "PushRoute", "QuarantineRoute", "RetentionPolicyRoute",
    "SearchRoute", "SetupRoute", "TaskListRoute", "TaskRoute", "TransportRuleRoute",
]);

/** The server's own route classes: what serves mail data (and how it is gated), or serves none. */
const SERVER_ROUTES: Record<string, string> = {
    MessageRawContentRoute: "mailbox: hasMailAccess READ on the message's folder; a non-owner read is audited",
    MailComposeRoute: "mailbox: hasMailAccess UPDATE on the draft's folder",
    EscrowInfoRoute: "mailbox: owner or explicit ACL record only (getRecord), no trusted bypass",
    ACLRoute: "admin: BaseGuardedACLRoute - ACLs governing mail need FULL as the caller themselves, a trusted role is no grant",
    AdminConsoleRoute: "admin: renders the admin console page, serves no data",
    AdminRoute: "admin: the framework's admin endpoints (@RequiresTrustedRole)",
    EscrowConsoleRoute: "admin: renders the escrow console page, serves no data",
    GiphySearchRoute: "user: proxies a GIF search, no mailbox data",
    MetricsRoute: "admin: metrics, token-gated",
    OpenAPIRoute: "public: the API description",
    PublicPageRoute: "public: the public web pages",
    StaticAssetRoute: "public: static files",
    StatusRoute: "public: readiness",
    wwwRoute: "user: renders the web client's page shells with the caller's own identity",
};

function routeNames(dir: string): string[] {
    return fs.readdirSync(path.join(SRC, dir)).filter((file) => file.endsWith(".ts")).map((file) => path.basename(file, ".ts")).sort();
}

describe("Mail access - server routes", () => {
    it.each(["mongo", "sql"])("Classifies every route class mounted by the %s server.", (backend) => {
        const unclassified = routeNames(`${backend}/routes`).filter((name) => !RESTAPI_ROUTES.has(name) && !(name in SERVER_ROUTES));
        expect(unclassified, `route classes with no classification (test/routes/MailAccessRoutes.test.ts): ${unclassified}`).toEqual([]);
    });

    it("Mounts the same route classes on both backends, except the web pages and the Mongo/SQL-specific ones.", () => {
        const mongo = routeNames("mongo/routes");
        const sql = routeNames("sql/routes");
        expect(sql.filter((name) => !mongo.includes(name))).toEqual([]);
    });

    it("Has no stale server classification.", () => {
        const mounted = new Set([...routeNames("mongo/routes"), ...routeNames("sql/routes"), "MessageRawContentRoute", "MailComposeRoute", "EscrowInfoRoute"]);
        expect(Object.keys(SERVER_ROUTES).filter((name) => !mounted.has(name))).toEqual([]);
    });

    it("Never calls ACLUtils.hasPermission() directly from a route: a trusted role is a superuser to it.", () => {
        const offenders = ["routes", "mongo/routes", "sql/routes"]
            .flatMap((dir) => fs.readdirSync(path.join(SRC, dir)).filter((file) => file.endsWith(".ts")).map((file) => path.join(dir, file)))
            .filter((file) => /aclUtils[!?]?\.hasPermission\(/.test(fs.readFileSync(path.join(SRC, file), "utf8")));
        expect(offenders).toEqual([]);
    });
});
