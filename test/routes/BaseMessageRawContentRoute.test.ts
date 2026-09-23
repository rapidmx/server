///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
// Isolated unit test for BaseMessageRawContentRoute, mocked at the repo/collaborator boundary rather
// than exercised against a real database - same convention as BaseMailComposeRoute.test.ts's own
// "assembleRaw() Tests (mocked collaborators)" block: `init()` only builds a repo when one isn't
// already set, so pre-populating the route's private fields before calling a route method bypasses
// real DI entirely while still running every real ACL/validation branch this route has.
import config from "../../src/config.mongo.js";
import { ObjectFactory } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import { BaseMessageRawContentRoute } from "../../src/routes/BaseMessageRawContentRoute.js";

class TestMessageRawContentRoute extends BaseMessageRawContentRoute<any> {
    protected messageClass: any = class {};
    protected mailboxClass: any = class {};
    protected auditLogClass: any = class {};
}

describe("BaseMessageRawContentRoute Tests (dependency guard clause only)", () => {
    const objectFactory: ObjectFactory = new ObjectFactory(config, Logger());

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("declares a per-user rate limit on raw(), unlike the generous default 'authenticated' tier - it loads a whole raw MIME blob into memory per request.", () => {
        const route = Reflect.getMetadata("rrst:route", BaseMessageRawContentRoute.prototype, "raw");
        expect(route.rateLimit).toMatchObject({ perUser: true, maxAttempts: 300, windowSeconds: 60 });
    });

    it("raw() throws INTERNAL_ERROR when blobStore/aclUtils are not set.", async () => {
        const route = objectFactory.newInstance<TestMessageRawContentRoute>(TestMessageRawContentRoute, { initialize: false });

        await expect(route.raw("m1", { setHeader: vi.fn(), send: vi.fn() } as any, { uid: "u1" } as any)).rejects.toThrow(
            /internal error/i,
        );
    });
});

describe("BaseMessageRawContentRoute.raw() Tests (mocked collaborators)", () => {
    const message = { uid: "m1", folderUid: "f1", mailboxUid: "mb1", subject: "Hello", bodyBlobKey: "bodies/abc123" };
    const user = { uid: "u1" } as any;

    function buildRoute(overrides: Partial<Record<string, any>> = {}) {
        const route = new (TestMessageRawContentRoute as any)();
        // restapi's recordAuditLog() caches the audit log repo per class, so each route gets its own class and repo.
        (route).auditLogClass = class {
            constructor(other: object) {
                Object.assign(this, other);
            }
        };
        (route).auditRepo = { create: vi.fn().mockResolvedValue(undefined) };
        (route)._objectFactory = { newInstance: vi.fn().mockReturnValue((route).auditRepo) };
        (route).config = config;
        (route).messageRepo = { findOne: vi.fn().mockResolvedValue(message) };
        (route).mailboxRepo = { findOne: vi.fn().mockResolvedValue({ uid: "mb1", ownerUserUid: "u1" }) };
        (route).aclUtils = { hasPermission: vi.fn().mockResolvedValue(true) };
        (route).blobStore = { get: vi.fn().mockResolvedValue(Buffer.from("raw mime source", "utf-8")) };
        Object.assign(route, overrides);
        return route as TestMessageRawContentRoute;
    }

    function fakeResponse() {
        return { setHeader: vi.fn(), send: vi.fn() };
    }

    it("rejects with NOT_FOUND when the message doesn't exist", async () => {
        const route = buildRoute({ messageRepo: { findOne: vi.fn().mockResolvedValue(undefined) } });
        await expect(route.raw("m1", fakeResponse() as any, user)).rejects.toThrow(/no resource could be found/i);
    });

    it("rejects with NOT_FOUND when the caller lacks READ permission on the folder", async () => {
        const route = buildRoute({ aclUtils: { hasPermission: vi.fn().mockResolvedValue(false) } });
        await expect(route.raw("m1", fakeResponse() as any, user)).rejects.toThrow(/no resource could be found/i);
    });

    it("hands the ACL check the caller WITHOUT their trusted roles - the framework answers yes to any trusted caller - so an administrator with no grant gets a 404", async () => {
        // A stand-in for `ACLUtils.hasPermission()`: yes to a trusted role (the framework's shortcut), else no.
        const hasPermission = vi.fn(async (u: any) => u?.roles?.includes("admin") === true);
        const route: any = buildRoute({ aclUtils: { hasPermission } });
        const admin = { uid: "admin-1", roles: ["admin"], scopes: [], elevated: Date.now() } as any;

        await expect(route.raw("m1", fakeResponse() as any, admin)).rejects.toThrow(/no resource could be found/i);

        expect(hasPermission).toHaveBeenCalledWith({ uid: "admin-1", roles: [], scopes: [], elevated: -1 }, "f1", "read");
        expect(route.blobStore.get).not.toHaveBeenCalled();
        expect(route.auditRepo.create).not.toHaveBeenCalled();
    });

    it("rejects with NOT_FOUND when the message has no stored body yet", async () => {
        const route = buildRoute({ messageRepo: { findOne: vi.fn().mockResolvedValue({ ...message, bodyBlobKey: undefined }) } });
        await expect(route.raw("m1", fakeResponse() as any, user)).rejects.toThrow(/no resource could be found/i);
    });

    it("streams the raw blob content with a message/rfc822 content type, never as HTML", async () => {
        const route = buildRoute();
        const res = fakeResponse();

        await route.raw("m1", res as any, user);

        expect((route as any).blobStore.get).toHaveBeenCalledWith("bodies/abc123");
        expect(res.setHeader).toHaveBeenCalledWith("content-type", "message/rfc822");
        // Raw, unsanitized MIME source must never be sniffable/renderable as HTML by a browser.
        expect(res.setHeader).toHaveBeenCalledWith("x-content-type-options", "nosniff");
        expect(res.send).toHaveBeenCalledWith(Buffer.from("raw mime source", "utf-8"));
    });

    it("doesn't audit the mailbox owner reading their own message", async () => {
        const route: any = buildRoute();
        await route.raw("m1", fakeResponse() as any, user);
        expect(route.auditRepo.create).not.toHaveBeenCalled();
    });

    it("audits a read by someone other than the mailbox owner as MESSAGE_CONTENT_ACCESSED", async () => {
        const route: any = buildRoute({ mailboxRepo: { findOne: vi.fn().mockResolvedValue({ uid: "mb1", ownerUserUid: "someone-else" }) } });
        const res = fakeResponse();
        await route.raw("m1", res as any, user);

        expect(route.mailboxRepo.findOne).toHaveBeenCalledWith("mb1", { ignoreACL: true });
        expect(route.auditRepo.create).toHaveBeenCalledTimes(1);
        const [entry, options] = route.auditRepo.create.mock.calls[0];
        expect(entry).toBeInstanceOf(route.auditLogClass);
        expect(entry).toMatchObject({
            action: "message.content_accessed",
            targetType: "Message",
            targetUid: "m1",
            mailboxUid: "mb1",
            actorUserUid: "u1",
            details: { subject: "Hello", raw: true },
        });
        expect(options).toEqual({ ignoreACL: true });
        expect(res.send).toHaveBeenCalled();
    });

    it("audits the read when the owning mailbox can't be found", async () => {
        const route: any = buildRoute({ mailboxRepo: { findOne: vi.fn().mockResolvedValue(undefined) } });
        await route.raw("m1", fakeResponse() as any, user);
        expect(route.auditRepo.create).toHaveBeenCalledTimes(1);
    });

    it("doesn't audit (or read the mailbox) when the read is refused", async () => {
        const route: any = buildRoute({ aclUtils: { hasPermission: vi.fn().mockResolvedValue(false) } });
        await expect(route.raw("m1", fakeResponse() as any, user)).rejects.toThrow(/no resource could be found/i);
        expect(route.mailboxRepo.findOne).not.toHaveBeenCalled();
        expect(route.auditRepo.create).not.toHaveBeenCalled();
    });
});
