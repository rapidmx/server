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
}

describe("BaseMessageRawContentRoute Tests (dependency guard clause only)", () => {
    const objectFactory: ObjectFactory = new ObjectFactory(config, Logger());

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("raw() throws INTERNAL_ERROR when blobStore/aclUtils are not set.", async () => {
        const route = objectFactory.newInstance<TestMessageRawContentRoute>(TestMessageRawContentRoute, { initialize: false });

        await expect(route.raw("m1", { setHeader: vi.fn(), send: vi.fn() } as any, { uid: "u1" } as any)).rejects.toThrow(
            /internal error/i,
        );
    });
});

describe("BaseMessageRawContentRoute.raw() Tests (mocked collaborators)", () => {
    const message = { uid: "m1", folderUid: "f1", bodyBlobKey: "bodies/abc123" };
    const user = { uid: "u1" } as any;

    function buildRoute(overrides: Partial<Record<string, any>> = {}) {
        const route = new (TestMessageRawContentRoute as any)();
        (route)._objectFactory = { newInstance: vi.fn() };
        (route).messageRepo = { findOne: vi.fn().mockResolvedValue(message) };
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
        expect(res.send).toHaveBeenCalledWith(Buffer.from("raw mime source", "utf-8"));
    });
});
