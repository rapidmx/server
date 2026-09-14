///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
// Isolated unit test for BaseMailComposeRoute's `!blobStore`/`!aclUtils` defensive guard, and its
// invalid-input guard — both are cheap to exercise without a real database. Full behavior (a real assemble
// producing MIME with attachments, permission-denied, nonexistent draft/mailbox) needs a wired ObjectFactory
// with real repos/BlobStore and is exercised indirectly through the mounted `/api/mail/compose/:id/assemble`
// route in normal server operation — this file only covers the guard clauses `MailComposeRoute`'s own
// concrete Mongo/SQL subclasses can't reach through a real request (DI always populates both dependencies
// before a request reaches the route).
import config from "../../src/config.mongo.js";
import { ObjectFactory } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import {
    assertRawMimeHeadersMatch,
    BaseMailComposeRoute,
    parseTopLevelHeaders,
    rewriteInlineImageSources,
    sanitizeComposeHtml,
} from "../../src/routes/BaseMailComposeRoute.js";

/** A minimal RFC 5322 message with the given top-level headers. */
function rawMessage(headers: string[]): string {
    return [...headers, "Subject: [...]", "MIME-Version: 1.0", "Content-Type: text/plain", "", "body"].join("\r\n");
}

class TestMailComposeRoute extends BaseMailComposeRoute<any, any, any, any> {
    protected messageClass: any = class {};
    protected attachmentClass: any = class {};
    protected mailboxClass: any = class {};
    protected folderClass: any = class {};
}

describe("BaseMailComposeRoute Tests (dependency guard clause only)", () => {
    const objectFactory: ObjectFactory = new ObjectFactory(config, Logger());

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("assemble() throws INTERNAL_ERROR when blobStore/aclUtils are not set.", async () => {
        const route = objectFactory.newInstance<TestMailComposeRoute>(TestMailComposeRoute, { initialize: false });

        await expect(
            route.assemble("m1", { to: [{ address: "a@example.com" }], html: "<p>hi</p>" }, { uid: "u1" } as any),
        ).rejects.toThrow(/internal error/i);
    });

    it("assembleRaw() throws INTERNAL_ERROR when blobStore/aclUtils are not set.", async () => {
        const route = objectFactory.newInstance<TestMailComposeRoute>(TestMailComposeRoute, { initialize: false });

        await expect(
            route.assembleRaw("m1", { to: [{ address: "a@example.com" }], subject: "[...]", rawMime: "raw mime source" }, { uid: "u1" } as any),
        ).rejects.toThrow(/internal error/i);
    });
});

/**
 * assembleRaw()'s full logic path, mocked at the repo/collaborator boundary rather than exercised
 * against a real database — `init()` only builds a repo when one isn't already set (see its own
 * source), so pre-populating the route's private fields before calling a route method bypasses real
 * DI entirely while still running every real ACL/validation/storage branch this method has.
 */
describe("BaseMailComposeRoute.assembleRaw() Tests (mocked collaborators)", () => {
    const message = { uid: "m1", version: 0, folderUid: "f1", mailboxUid: "mb1" };
    const draftsFolder = { uid: "f1", type: "drafts" };
    const mailbox = { uid: "mb1", displayName: "Alice", primarySmtpAddress: "alice@example.com", aliasAddresses: ["al@example.com"] };
    const user = { uid: "u1" } as any;
    const rawMime = rawMessage(["From: \"Alice\" <alice@example.com>", "To: bob@example.com"]);
    const validInput = { to: [{ address: "bob@example.com" }], subject: "[...]", rawMime };

    function buildRoute(overrides: Partial<Record<string, any>> = {}) {
        const route = new (TestMailComposeRoute as any)();
        (route)._objectFactory = { newInstance: vi.fn() };
        (route).messageRepo = { findOne: vi.fn().mockResolvedValue(message), update: vi.fn().mockResolvedValue(message) };
        (route).folderRepo = { findOne: vi.fn().mockResolvedValue(draftsFolder) };
        (route).mailboxRepo = { findOne: vi.fn().mockResolvedValue(mailbox) };
        (route).attachmentRepo = { count: vi.fn().mockResolvedValue(0) };
        (route).aclUtils = { hasPermission: vi.fn().mockResolvedValue(true) };
        (route).blobStore = { put: vi.fn().mockResolvedValue(undefined) };
        Object.assign(route, overrides);
        return route as TestMailComposeRoute;
    }

    it("rejects when 'to' is empty", async () => {
        const route = buildRoute();
        await expect(route.assembleRaw("m1", { ...validInput, to: [] }, user)).rejects.toThrow(/invalid/i);
    });

    it("rejects when rawMime is missing", async () => {
        const route = buildRoute();
        await expect(route.assembleRaw("m1", { ...validInput, rawMime: "" }, user)).rejects.toThrow(/invalid/i);
    });

    it("rejects with NOT_FOUND when the draft doesn't exist", async () => {
        const route = buildRoute({ messageRepo: { findOne: vi.fn().mockResolvedValue(undefined) } });
        await expect(route.assembleRaw("m1", validInput, user)).rejects.toThrow(/no resource could be found/i);
    });

    it("rejects with AUTH_PERMISSION_FAILURE when the caller lacks UPDATE on the folder", async () => {
        const route = buildRoute({ aclUtils: { hasPermission: vi.fn().mockResolvedValue(false) } });
        await expect(route.assembleRaw("m1", validInput, user)).rejects.toThrow(/permission/i);
    });

    it("rejects when the message's folder isn't Drafts", async () => {
        const route = buildRoute({ folderRepo: { findOne: vi.fn().mockResolvedValue({ uid: "f1", type: "inbox" }) } });
        await expect(route.assembleRaw("m1", validInput, user)).rejects.toThrow(/only a message in drafts/i);
    });

    it("rejects with NOT_FOUND when the owning mailbox doesn't exist", async () => {
        const route = buildRoute({ mailboxRepo: { findOne: vi.fn().mockResolvedValue(undefined) } });
        await expect(route.assembleRaw("m1", validInput, user)).rejects.toThrow(/no resource could be found/i);
    });

    it("rejects when the draft already has file attachments uploaded", async () => {
        const route = buildRoute({ attachmentRepo: { count: vi.fn().mockResolvedValue(2) } });
        await expect(route.assembleRaw("m1", validInput, user)).rejects.toThrow(/cannot include file attachments/i);
    });

    it("stores the raw MIME source byte-for-byte and updates the message with server-derived from/recipients", async () => {
        const route = buildRoute();
        const result = await route.assembleRaw("m1", validInput, user);

        expect((route as any).blobStore.put).toHaveBeenCalledWith(
            expect.stringMatching(/^bodies\//),
            Buffer.from(rawMime, "utf-8"),
            { contentType: "message/rfc822" },
        );
        const updatePatch = (route as any).messageRepo.update.mock.calls[0][0];
        expect(updatePatch.subject).toBe("[...]");
        expect(updatePatch.from).toEqual({ address: "alice@example.com", displayName: "Alice", type: "to" });
        expect(updatePatch.recipients).toEqual([{ address: "bob@example.com", type: "to" }]);
        expect(updatePatch.bodyPreview).toBe("");
        expect(updatePatch.hasAttachments).toBe(false);
        expect(result).toBe(message);
    });

    it("includes cc/bcc recipients with their own types", async () => {
        const route = buildRoute();
        await route.assembleRaw(
            "m1",
            {
                ...validInput,
                rawMime: rawMessage(["From: alice@example.com", "To: bob@example.com", "Cc: carol@example.com"]),
                cc: [{ address: "carol@example.com" }],
                bcc: [{ address: "dave@example.com" }],
            },
            user,
        );
        const updatePatch = (route as any).messageRepo.update.mock.calls[0][0];
        expect(updatePatch.recipients).toEqual([
            { address: "bob@example.com", type: "to" },
            { address: "carol@example.com", type: "cc" },
            { address: "dave@example.com", type: "bcc" },
        ]);
    });
});

describe("BaseMailComposeRoute.assembleRaw() header and size checks", () => {
    const message = { uid: "m1", version: 0, folderUid: "f1", mailboxUid: "mb1" };
    const mailbox = { uid: "mb1", displayName: "Alice", primarySmtpAddress: "alice@example.com", aliasAddresses: ["al@example.com"] };
    const user = { uid: "u1" } as any;

    function buildRoute(maxBytes?: number) {
        const route = new (TestMailComposeRoute as any)();
        route._objectFactory = { newInstance: vi.fn() };
        route.messageRepo = { findOne: vi.fn().mockResolvedValue(message), update: vi.fn().mockResolvedValue(message) };
        route.folderRepo = { findOne: vi.fn().mockResolvedValue({ uid: "f1", type: "drafts" }) };
        route.mailboxRepo = { findOne: vi.fn().mockResolvedValue(mailbox) };
        route.attachmentRepo = { count: vi.fn().mockResolvedValue(0) };
        route.aclUtils = { hasPermission: vi.fn().mockResolvedValue(true) };
        route.blobStore = { put: vi.fn().mockResolvedValue(undefined) };
        route.config = { get: (key: string) => (key === "mail:compose:max_attachment_bytes" ? maxBytes : undefined) };
        return route as TestMailComposeRoute;
    }

    const input = (headers: string[]) => ({ to: [{ address: "bob@example.com" }], subject: "[...]", rawMime: rawMessage(headers) });

    it("rejects a From address the mailbox doesn't own, and stores nothing", async () => {
        const route = buildRoute();
        await expect(route.assembleRaw("m1", input(["From: ceo@example.com", "To: bob@example.com"]), user)).rejects.toThrow(
            /From header/,
        );
        expect((route as any).blobStore.put).not.toHaveBeenCalled();
    });

    it("accepts an alias address as From, case-insensitively", async () => {
        const route = buildRoute();
        await route.assembleRaw("m1", input(["FROM: Al <AL@Example.com>", "To: Bob <bob@example.com>"]), user);
        expect((route as any).blobStore.put).toHaveBeenCalled();
    });

    it("rejects a message over mail:compose:max_attachment_bytes with 413, and stores nothing", async () => {
        const route = buildRoute(64);
        await expect(route.assembleRaw("m1", input(["From: alice@example.com", "To: bob@example.com"]), user)).rejects.toMatchObject({
            status: 413,
        });
        expect((route as any).blobStore.put).not.toHaveBeenCalled();
    });
});

describe("assertRawMimeHeadersMatch()", () => {
    const mailbox = { primarySmtpAddress: "alice@example.com", aliasAddresses: ["al@example.com"] };
    const to = [{ address: "bob@example.com" }];
    const check = (headers: string[], body: any = { to }) => () => assertRawMimeHeadersMatch(rawMessage(headers), mailbox, body);

    it("accepts matching From/To/Cc, a Sender belonging to the mailbox, and any Reply-To", () => {
        const headers = ["From: alice@example.com", "Sender: al@example.com", "Reply-To: team@elsewhere.com", "To: bob@example.com", "Cc: c@example.com"];
        expect(check(headers, { to, cc: [{ address: "c@example.com" }] })).not.toThrow();
    });

    it("rejects a missing From, several From headers, or several From addresses", () => {
        expect(check(["To: bob@example.com"])).toThrow(/From header/);
        expect(check(["From: alice@example.com", "From: alice@example.com", "To: bob@example.com"])).toThrow(/From header/);
        expect(check(["From: alice@example.com, al@example.com", "To: bob@example.com"])).toThrow(/From header/);
    });

    it("rejects a Sender that isn't the mailbox's", () => {
        expect(check(["From: alice@example.com", "Sender: mallory@example.com", "To: bob@example.com"])).toThrow(/Sender header/);
    });

    it("rejects any Bcc or Resent-* header", () => {
        expect(check(["From: alice@example.com", "To: bob@example.com", "Bcc: dave@example.com"])).toThrow(/Bcc/);
        expect(check(["From: alice@example.com", "To: bob@example.com", "Resent-From: ceo@example.com"])).toThrow(/Resent/);
    });

    it("rejects To/Cc headers that don't match the draft's recipients", () => {
        expect(check(["From: alice@example.com", "To: bob@example.com, eve@example.com"])).toThrow(/To header/);
        expect(check(["From: alice@example.com", "To: bob@example.com", "Cc: eve@example.com"])).toThrow(/Cc header/);
        expect(check(["From: alice@example.com", "To: bob@example.com"], { to, cc: [{ address: "carol@example.com" }] })).toThrow(
            /Cc header/,
        );
    });

    it("only reads the top-level header block, not header-like lines in the body", () => {
        const raw = "From: alice@example.com\r\nTo: bob@example.com\r\n\r\nBcc: not-a-header@example.com\r\nFrom: x@y.com\r\n";
        expect(() => assertRawMimeHeadersMatch(raw, mailbox, { to })).not.toThrow();
    });

    it("unfolds folded header lines and rejects malformed ones", () => {
        expect(parseTopLevelHeaders("To: a@example.com,\r\n b@example.com\r\n\r\nbody").get("to")).toEqual(["a@example.com, b@example.com"]);
        expect(() => parseTopLevelHeaders("not a header\r\n\r\nbody")).toThrow(/malformed/);
        expect(() => parseTopLevelHeaders(" folded first\r\n\r\nbody")).toThrow(/folded/);
    });
});

describe("sanitizeComposeHtml() Tests", () => {
    it("strips <script> tags entirely — the actual security boundary for outbound compose HTML.", () => {
        const result = sanitizeComposeHtml('<p>hi</p><script>alert("xss")</script>');
        expect(result).not.toContain("<script");
        expect(result).not.toContain("alert");
        expect(result).toContain("<p>hi</p>");
    });

    it("strips event-handler attributes (onerror/onclick/etc.) even on an otherwise-allowed tag.", () => {
        const result = sanitizeComposeHtml('<img src="https://example.com/x.png" onerror="alert(1)">');
        expect(result).not.toContain("onerror");
        expect(result).toContain('src="https://example.com/x.png"');
    });

    it("allows the basic formatting tags RichTextEditor's StarterKit-based toolbar produces.", () => {
        const result = sanitizeComposeHtml(
            "<h1>Title</h1><p><strong>bold</strong> <em>italic</em> <u>under</u> <s>strike</s></p>" +
                '<ul><li>one</li></ul><blockquote>quote</blockquote><a href="https://example.com">link</a>',
        );
        expect(result).toContain("<h1>Title</h1>");
        expect(result).toContain("<strong>bold</strong>");
        expect(result).toContain("<em>italic</em>");
        expect(result).toContain("<u>under</u>");
        expect(result).toContain("<s>strike</s>");
        expect(result).toContain("<li>one</li>");
        expect(result).toContain("<blockquote>quote</blockquote>");
        expect(result).toContain('href="https://example.com"');
    });

    it("allows a table, matching RichTextEditor's TableKit output.", () => {
        const result = sanitizeComposeHtml("<table><tbody><tr><td>cell</td></tr></tbody></table>");
        expect(result).toContain("<table>");
        expect(result).toContain("<td>cell</td>");
    });

    it("allows the specific inline style properties TextStyleKit/TextAlign emit, with safe values.", () => {
        const result = sanitizeComposeHtml(
            '<p style="text-align: center"><span style="color: #ff0000; font-family: Arial, sans-serif; font-size: 18px">styled</span></p>',
        );
        expect(result).toContain("text-align:center");
        expect(result).toContain("color:#ff0000");
        expect(result).toContain("font-family:Arial, sans-serif");
        expect(result).toContain("font-size:18px");
    });

    it("strips a style property outside the allowlist (e.g. a CSS-injection attempt) while keeping the tag.", () => {
        const result = sanitizeComposeHtml('<p style="position: fixed; color: #00ff00">text</p>');
        expect(result).not.toContain("position");
        expect(result).toContain("color:#00ff00");
        expect(result).toContain("text");
    });

    it("allows a cid: scheme image src, for an inline image referencing an already-uploaded attachment.", () => {
        const result = sanitizeComposeHtml('<img src="cid:attachment-1">');
        expect(result).toContain('src="cid:attachment-1"');
    });

    it("rejects a javascript: scheme link href.", () => {
        const result = sanitizeComposeHtml('<a href="javascript:alert(1)">click</a>');
        expect(result).not.toContain("javascript:");
    });
});

describe("rewriteInlineImageSources() Tests", () => {
    it("rewrites a matching attachment's content URL to its cid.", () => {
        const html = '<p>look</p><img src="/api/mail/attachments/a1/content">';
        const result = rewriteInlineImageSources(html, [{ uid: "a1", contentId: "content-id-1" }]);
        expect(result).toBe('<p>look</p><img src="cid:content-id-1">');
    });

    it("rewrites every occurrence of the same attachment's URL, e.g. if inserted twice.", () => {
        const html = '<img src="/api/mail/attachments/a1/content"><img src="/api/mail/attachments/a1/content">';
        const result = rewriteInlineImageSources(html, [{ uid: "a1", contentId: "cid-1" }]);
        expect(result).toBe('<img src="cid:cid-1"><img src="cid:cid-1">');
    });

    it("leaves html untouched when no attachment's URL appears in it.", () => {
        const html = '<img src="https://example.com/cat.png">';
        expect(rewriteInlineImageSources(html, [{ uid: "a1", contentId: "cid-1" }])).toBe(html);
    });

    it("skips an attachment with no contentId, rather than rewriting to 'cid:undefined'.", () => {
        const html = '<img src="/api/mail/attachments/a1/content">';
        expect(rewriteInlineImageSources(html, [{ uid: "a1" }])).toBe(html);
    });

    it("only rewrites the specific attachment referenced, leaving a plain file attachment's own URL (never inserted inline) alone.", () => {
        const html = '<img src="/api/mail/attachments/a1/content">';
        const result = rewriteInlineImageSources(html, [
            { uid: "a1", contentId: "cid-1" },
            { uid: "a2", contentId: "cid-2" },
        ]);
        expect(result).toBe('<img src="cid:cid-1">');
    });
});
