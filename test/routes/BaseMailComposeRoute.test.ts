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
import { BaseEntity, ObjectFactory } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import {
    assertRawMimeHeadersMatch,
    BaseMailComposeRoute,
    decodeEncodedWords,
    parseTopLevelHeaders,
    rewriteInlineImageSources,
    safeFromDisplayName,
    sanitizeComposeHtml,
} from "../../src/routes/BaseMailComposeRoute.js";

/** A minimal RFC 5322 message with the given top-level headers. */
function rawMessage(headers: string[]): string {
    return [...headers, "Subject: [...]", "MIME-Version: 1.0", "Content-Type: text/plain", "", "body"].join("\r\n");
}

/** Stands in for a model class: like the real ones, its constructor copies the given fields. */
class TestMessage {
    constructor(other?: object) {
        Object.assign(this, other);
    }
}

class TestMailComposeRoute extends BaseMailComposeRoute<any, any, any, any> {
    protected messageClass: any = TestMessage;
    protected attachmentClass: any = class {};
    protected mailboxClass: any = class {};
    protected folderClass: any = class {};
    protected matterClass: any = class {};
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

    it("rejects a delivered message that a mail filter moved into Drafts", async () => {
        const route = buildRoute({ messageRepo: { findOne: vi.fn().mockResolvedValue({ ...message, scanResultUid: "scan-1" }), update: vi.fn() } });
        await expect(route.assembleRaw("m1", validInput, user)).rejects.toThrow(/delivered message can't be edited/i);
        expect((route as any).blobStore.put).not.toHaveBeenCalled();
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
        await route.assembleRaw("m1", input(["FROM: Alice <AL@Example.com>","To: Bob <bob@example.com>"]), user);
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

describe("BaseMailComposeRoute replaced body blobs", () => {
    const mailbox = { uid: "mb1", displayName: "Alice", primarySmtpAddress: "alice@example.com", aliasAddresses: [] };
    const user = { uid: "u1" } as any;
    const rawInput = {
        to: [{ address: "bob@example.com" }],
        subject: "[...]",
        rawMime: rawMessage(["From: alice@example.com", "To: bob@example.com"]),
    };
    const htmlInput = { to: [{ address: "bob@example.com" }], html: "<p>hi</p>" };

    function buildRoute(bodyBlobKey: string | undefined, opts: { references?: number; updateError?: Error; matters?: any[] } = {}) {
        const message = { uid: "m1", version: 3, folderUid: "f1", mailboxUid: "mb1", bodyBlobKey };
        const route = new (TestMailComposeRoute as any)();
        route._objectFactory = { newInstance: vi.fn() };
        route.messageRepo = {
            findOne: vi.fn().mockResolvedValue(message),
            update: opts.updateError ? vi.fn().mockRejectedValue(opts.updateError) : vi.fn().mockResolvedValue(message),
            count: vi.fn().mockResolvedValue(opts.references ?? 0),
        };
        route.folderRepo = { findOne: vi.fn().mockResolvedValue({ uid: "f1", type: "drafts" }) };
        route.mailboxRepo = { findOne: vi.fn().mockResolvedValue(mailbox) };
        route.attachmentRepo = { count: vi.fn().mockResolvedValue(0), find: vi.fn().mockResolvedValue([]) };
        route.aclUtils = { hasPermission: vi.fn().mockResolvedValue(true) };
        route.blobStore = { put: vi.fn().mockResolvedValue(undefined), delete: vi.fn().mockResolvedValue(undefined) };
        route.matterRepo = { find: vi.fn().mockResolvedValue(opts.matters ?? []) };
        return route;
    }

    it.each([
        ["assembleRaw", (route: any) => route.assembleRaw("m1", rawInput, user)],
        ["assemble", (route: any) => route.assemble("m1", htmlInput, user)],
    ])("%s() deletes the body blob it replaces once no message references it", async (_name, run) => {
        const route = buildRoute("bodies/old");
        await run(route);

        const newKey: string = route.blobStore.put.mock.calls[0][0];
        expect(route.messageRepo.update.mock.calls[0][0].bodyBlobKey).toBe(newKey);
        expect(route.messageRepo.count).toHaveBeenCalledWith({ bodyBlobKey: "eq(bodies/old)" }, { ignoreACL: true, includeDeleted: true });
        expect(route.blobStore.delete).toHaveBeenCalledWith("bodies/old");
        expect(route.blobStore.delete).not.toHaveBeenCalledWith(newKey);
    });

    it("keeps the replaced blob while another message still references it", async () => {
        const route = buildRoute("bodies/old", { references: 1 });
        await route.assembleRaw("m1", rawInput, user);
        expect(route.blobStore.delete).not.toHaveBeenCalled();
    });

    it("never deletes a replaced blob this compose path didn't create, or when there was none", async () => {
        for (const key of ["ingest/raw-1", undefined]) {
            const route = buildRoute(key);
            await route.assembleRaw("m1", rawInput, user);
            expect(route.messageRepo.count).not.toHaveBeenCalled();
            expect(route.blobStore.delete).not.toHaveBeenCalled();
        }
    });

    it("deletes the new blob and keeps the old one when the update fails", async () => {
        const route = buildRoute("bodies/old", { updateError: new Error("version conflict") });
        await expect(route.assembleRaw("m1", rawInput, user)).rejects.toThrow(/version conflict/);
        const newKey: string = route.blobStore.put.mock.calls[0][0];
        expect(route.blobStore.delete).toHaveBeenCalledTimes(1);
        expect(route.blobStore.delete).toHaveBeenCalledWith(newKey);
    });

    it("still returns the updated draft when deleting the replaced blob fails", async () => {
        const route = buildRoute("bodies/old");
        route.blobStore.delete.mockRejectedValue(new Error("store down"));
        await expect(route.assembleRaw("m1", rawInput, user)).resolves.toMatchObject({ uid: "m1" });
    });

    it("keeps the replaced blob while an open Matter holds the mailbox", async () => {
        const route = buildRoute("bodies/old", { matters: [{ uid: "mt1", custodianMailboxUids: ["other", "mb1"] }] });
        await route.assemble("m1", htmlInput, user);
        expect(route.matterRepo.find).toHaveBeenCalledWith(
            { sort: { uid: "ASC" }, limit: 500 },
            { ignoreACL: true, limit: 500, skipCache: true },
        );
        expect(route.blobStore.delete).not.toHaveBeenCalled();
    });

    it("deletes the replaced blob when the only Matters naming the mailbox are closed, or name other mailboxes", async () => {
        const route = buildRoute("bodies/old", {
            matters: [
                { uid: "mt1", custodianMailboxUids: ["mb1"], closedAt: new Date() },
                { uid: "mt2", custodianMailboxUids: ["other"] },
            ],
        });
        await route.assemble("m1", htmlInput, user);
        expect(route.blobStore.delete).toHaveBeenCalledWith("bodies/old");
    });

    it("finds a hold past the first page of Matters", async () => {
        const route = buildRoute("bodies/old");
        const firstPage = Array.from({ length: 500 }, (_v, i) => ({ uid: `a${String(i).padStart(3, "0")}`, custodianMailboxUids: [] }));
        route.matterRepo.find
            .mockResolvedValueOnce(firstPage)
            .mockResolvedValueOnce([{ uid: "b000", custodianMailboxUids: ["mb1"] }]);
        await route.assemble("m1", htmlInput, user);
        expect(route.matterRepo.find.mock.calls[1][0]).toEqual({ sort: { uid: "ASC" }, limit: 500, uid: "gt(a499)" });
        expect(route.blobStore.delete).not.toHaveBeenCalled();
    });

    it("keeps the replaced blob when the legal hold lookup fails", async () => {
        const route = buildRoute("bodies/old");
        route.matterRepo.find.mockRejectedValue(new Error("db down"));
        await expect(route.assemble("m1", htmlInput, user)).resolves.toMatchObject({ uid: "m1" });
        expect(route.blobStore.delete).not.toHaveBeenCalled();
    });
});

describe("BaseMailComposeRoute.assemble() drafts and From", () => {
    const user = { uid: "u1" } as any;

    function buildRoute(opts: { displayName?: string; message?: any } = {}) {
        const message = opts.message ?? { uid: "m1", version: 2, folderUid: "f1", mailboxUid: "mb1" };
        const route = new (TestMailComposeRoute as any)();
        route._objectFactory = { newInstance: vi.fn() };
        route.messageRepo = { findOne: vi.fn().mockResolvedValue(message), update: vi.fn().mockResolvedValue(message) };
        route.folderRepo = { findOne: vi.fn().mockResolvedValue({ uid: "f1", type: "drafts" }) };
        route.mailboxRepo = {
            findOne: vi.fn().mockResolvedValue({ uid: "mb1", displayName: opts.displayName, primarySmtpAddress: "alice@example.com" }),
        };
        route.attachmentRepo = { find: vi.fn().mockResolvedValue([]) };
        route.aclUtils = { hasPermission: vi.fn().mockResolvedValue(true) };
        route.blobStore = { put: vi.fn().mockResolvedValue(undefined) };
        route.matterRepo = { find: vi.fn().mockResolvedValue([]) };
        return route;
    }

    const storedMime = (route: any): string => route.blobStore.put.mock.calls[0][1].toString("utf-8");

    it("stores a draft with no recipients and an empty body (autosave before anything is filled in)", async () => {
        for (const input of [{}, { to: [], html: "" }, { subject: "Notes", cc: [{ address: "carol@example.com" }] }]) {
            const route = buildRoute({ displayName: "Alice" });
            await route.assemble("m1", input, user);
            const patch = route.messageRepo.update.mock.calls[0][0];
            expect(route.blobStore.put).toHaveBeenCalled();
            expect(storedMime(route)).not.toMatch(/^To:/m);
            expect(patch.recipients).toEqual((input as any).cc ? [{ address: "carol@example.com", type: "cc" }] : []);
            expect(patch.bodyPreview).toBe("");
        }
    });

    it("refuses to rewrite a delivered message that a mail filter moved into Drafts", async () => {
        const route = buildRoute({ message: { uid: "m1", version: 2, folderUid: "f1", mailboxUid: "mb1", scanResultUid: "scan-1" } });
        await expect(route.assemble("m1", { html: "<p>forged</p>" }, user)).rejects.toThrow(/delivered message can't be edited/i);
        expect(route.blobStore.put).not.toHaveBeenCalled();
        expect(route.messageRepo.update).not.toHaveBeenCalled();
    });

    it("still rejects malformed input", async () => {
        for (const input of [
            undefined,
            { to: "bob@example.com" },
            { to: [{ name: "no address" }] },
            { cc: {} },
            { html: 42 },
            { subject: ["x"] },
        ]) {
            const route = buildRoute();
            await expect(route.assemble("m1", input, user)).rejects.toThrow(/invalid/i);
            expect(route.blobStore.put).not.toHaveBeenCalled();
        }
    });

    it("puts the mailbox's display name in From", async () => {
        const route = buildRoute({ displayName: "Alice Smith" });
        await route.assemble("m1", { to: [{ address: "bob@example.com" }], html: "<p>hi</p>" }, user);
        expect(storedMime(route)).toMatch(/^From: Alice Smith <alice@example.com>\r?$/m);
        expect(route.messageRepo.update.mock.calls[0][0].from).toEqual({ address: "alice@example.com", displayName: "Alice Smith", type: "to" });
    });

    it("uses the bare address in From when the display name contains @ or a line break", async () => {
        for (const displayName of ["ceo@example.com", "Alice\r\nBcc: x@evil.com", "Alice\nSmith", "", undefined]) {
            const route = buildRoute({ displayName });
            await route.assemble("m1", { to: [{ address: "bob@example.com" }], html: "<p>hi</p>" }, user);
            const mime = storedMime(route);
            expect(mime).toMatch(/^From: alice@example.com\r?$/m);
            expect(mime).not.toMatch(/evil|ceo@/);
            expect(route.messageRepo.update.mock.calls[0][0].from.displayName).toBeUndefined();
        }
    });

    it("passes the draft to update() as a model instance, so the optimistic lock applies to a plain document", async () => {
        const route = buildRoute();
        await route.assemble("m1", { html: "<p>hi</p>" }, user);
        const [patch, existing] = route.messageRepo.update.mock.calls[0];
        expect(existing).toBeInstanceOf(TestMessage);
        expect(existing).toMatchObject({ uid: "m1", version: 2 });
        expect(patch.version).toBe(2);
    });

    it("passes an entity instance through unchanged", async () => {
        const entity = Object.assign(Object.create(BaseEntity.prototype), { uid: "m1", version: 5, folderUid: "f1", mailboxUid: "mb1" });
        const route = buildRoute({ message: entity });
        await route.assemble("m1", { html: "<p>hi</p>" }, user);
        expect(route.messageRepo.update.mock.calls[0][1]).toBe(entity);
    });
});

describe("safeFromDisplayName()", () => {
    it("keeps an ordinary name, trimmed, and drops address-like, multi-line or empty ones", () => {
        expect(safeFromDisplayName("  Alice Smith ")).toBe("Alice Smith");
        expect(safeFromDisplayName("bob@example.com")).toBeUndefined();
        expect(safeFromDisplayName("Bob\r\nX: y")).toBeUndefined();
        expect(safeFromDisplayName("   ")).toBeUndefined();
        expect(safeFromDisplayName(undefined)).toBeUndefined();
    });
});

describe("assertRawMimeHeadersMatch()", () => {
    const mailbox = { primarySmtpAddress: "alice@example.com", aliasAddresses: ["al@example.com"], displayName: "Alice Smith" };
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

    it("accepts no display name or the mailbox's own, including RFC 2047-encoded, on From and Sender", () => {
        for (const from of [
            "alice@example.com",
            "<alice@example.com>",
            "Alice Smith <alice@example.com>",
            '"Alice Smith" <alice@example.com>',
            "=?UTF-8?B?QWxpY2UgU21pdGg=?= <alice@example.com>",
            "=?utf-8?Q?Alice_Smith?= <al@example.com>",
        ]) {
            expect(check([`From: ${from}`, `Sender: ${from}`, "To: bob@example.com"]), from).not.toThrow();
        }
    });

    it("only accepts a bare From address when the mailbox's display name is address-like", () => {
        const odd = { ...mailbox, displayName: "ceo@example.com" };
        expect(() => assertRawMimeHeadersMatch(rawMessage(["From: alice@example.com", "To: bob@example.com"]), odd, { to })).not.toThrow();
        expect(() =>
            assertRawMimeHeadersMatch(rawMessage(["From: \"ceo@example.com\" <alice@example.com>", "To: bob@example.com"]), odd, { to }),
        ).toThrow(/From header/);
    });

    it("rejects any other display name on From or Sender", () => {
        expect(check(["From: CEO <alice@example.com>", "To: bob@example.com"])).toThrow(/From header/);
        expect(check(["From: =?UTF-8?B?Q0VP?= <alice@example.com>", "To: bob@example.com"])).toThrow(/From header/);
        expect(check(["From: alice@example.com", "Sender: Support <al@example.com>", "To: bob@example.com"])).toThrow(/Sender header/);
    });

    it("rejects From/Sender values with a second address or address-like leftovers", () => {
        for (const from of [
            "bob@evil.com <alice@example.com>",
            "Alice Smith <alice@example.com> <x@evil.com>",
            "Alice Smith <alice@example.com> bob@evil.com",
            "alice@example.com (evil@example.net)",
            "Group: alice@example.com;",
        ]) {
            expect(check([`From: ${from}`, "To: bob@example.com"]), from).toThrow(/From header/);
            expect(check(["From: alice@example.com", `Sender: ${from}`, "To: bob@example.com"]), from).toThrow(/Sender header/);
        }
    });

    it("rejects trace and authentication headers a relay or receiver would add", () => {
        for (const header of [
            "Authentication-Results: mx.example.com; dkim=pass",
            "DKIM-Signature: v=1; d=example.com",
            "Received: from x by y",
            "Received-SPF: pass",
            "Return-Path: <ceo@example.com>",
            "ARC-Seal: i=1",
            "ARC-Authentication-Results: i=1; mx.example.com",
            "RapidMX-Key: addr=alice@example.com",
            "RapidMX-Key-Gossip: addr=bob@example.com",
            "X-RapidMX-Spam: no",
        ]) {
            expect(check(["From: alice@example.com", "To: bob@example.com", header]), header).toThrow(/only a receiving or relaying server/);
        }
    });

    it("decodeEncodedWords() joins adjacent encoded-words and leaves invalid ones as-is", () => {
        expect(decodeEncodedWords("=?UTF-8?B?QWxp?= =?UTF-8?B?Y2U=?=")).toBe("Alice");
        expect(decodeEncodedWords("=?ISO-8859-1?Q?Andr=E9?= Smith")).toBe("André Smith");
        expect(decodeEncodedWords("=?x-unknown?B?QQ==?=")).toBe("=?x-unknown?B?QQ==?=");
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
