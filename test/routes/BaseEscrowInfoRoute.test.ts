///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
// Isolated unit test for BaseEscrowInfoRoute, mocked at the repo/collaborator boundary rather than
// exercised against a real database - same convention as BaseMessageRawContentRoute.test.ts's own
// "mocked collaborators" block: init() only builds a repo when one isn't already set, so pre-populating
// the route's private fields before calling a route method bypasses real DI entirely while still
// running every real access-check/validation branch this route has.
import config from "../../src/config.mongo.js";
import { ObjectFactory } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import { BaseEscrowInfoRoute } from "../../src/routes/BaseEscrowInfoRoute.js";

class TestEscrowInfoRoute extends BaseEscrowInfoRoute<any> {
    protected mailboxClass: any = class {};
    protected escrowScopeClass: any = class {};
}

describe("BaseEscrowInfoRoute Tests (dependency guard clause only)", () => {
    const objectFactory: ObjectFactory = new ObjectFactory(config, Logger());

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("escrowInfo() throws INTERNAL_ERROR when aclUtils is not set.", async () => {
        const route = objectFactory.newInstance<TestEscrowInfoRoute>(TestEscrowInfoRoute, { initialize: false });

        await expect(route.escrowInfo("mb1", { uid: "u1" } as any)).rejects.toThrow(/internal error/i);
    });
});

describe("BaseEscrowInfoRoute.escrowInfo() Tests (mocked collaborators)", () => {
    const mailbox = { uid: "mb1", ownerUserUid: "owner-1", escrowScopeId: "scope-1" };
    const scope = { uid: "scope-1", publicKey: { publicKey: "base64cert", type: "x509", fingerprint: "fp1", notBefore: 0, notAfter: 1 } };
    const owner = { uid: "owner-1" } as any;
    const stranger = { uid: "stranger-1" } as any;

    function buildRoute(overrides: Partial<Record<string, any>> = {}) {
        const route = new (TestEscrowInfoRoute as any)();
        (route)._objectFactory = { newInstance: vi.fn() };
        (route).mailboxRepo = { findOne: vi.fn().mockResolvedValue(mailbox) };
        (route).escrowScopeRepo = { findOne: vi.fn().mockResolvedValue(scope) };
        (route).aclUtils = { findACL: vi.fn().mockResolvedValue(undefined), getRecord: vi.fn() };
        Object.assign(route, overrides);
        return route as TestEscrowInfoRoute;
    }

    it("rejects with NOT_FOUND when the mailbox doesn't exist", async () => {
        const route = buildRoute({ mailboxRepo: { findOne: vi.fn().mockResolvedValue(undefined) } });
        await expect(route.escrowInfo("mb1", stranger)).rejects.toThrow(/no resource could be found/i);
    });

    it("rejects with AUTH_PERMISSION_FAILURE for a caller who is neither the owner nor holds an ACL grant", async () => {
        const route = buildRoute();
        await expect(route.escrowInfo("mb1", stranger)).rejects.toThrow(/permission/i);
    });

    it("rejects with AUTH_PERMISSION_FAILURE when no ACL exists at all for an anonymous caller", async () => {
        const route = buildRoute();
        await expect(route.escrowInfo("mb1", undefined)).rejects.toThrow(/permission/i);
    });

    it("rejects with AUTH_PERMISSION_FAILURE when the caller's ACL record grants neither READ nor FULL", async () => {
        const route = buildRoute({
            aclUtils: {
                findACL: vi.fn().mockResolvedValue({ uid: "mb1" }),
                getRecord: vi.fn().mockReturnValue({ actions: ["update"] }),
            },
        });
        await expect(route.escrowInfo("mb1", stranger)).rejects.toThrow(/permission/i);
    });

    it("returns the scope's public key for the mailbox's owner", async () => {
        const route = buildRoute();
        const result = await route.escrowInfo("mb1", owner);
        expect(result).toEqual({ escrowScopeId: "scope-1", publicKey: scope.publicKey });
    });

    it("returns the scope's public key for a delegate with an ACL READ grant", async () => {
        const route = buildRoute({
            aclUtils: {
                findACL: vi.fn().mockResolvedValue({ uid: "mb1" }),
                getRecord: vi.fn().mockReturnValue({ actions: ["read"] }),
            },
        });
        const result = await route.escrowInfo("mb1", stranger);
        expect(result).toEqual({ escrowScopeId: "scope-1", publicKey: scope.publicKey });
    });

    it("returns the scope's public key for a delegate with an ACL FULL grant", async () => {
        const route = buildRoute({
            aclUtils: {
                findACL: vi.fn().mockResolvedValue({ uid: "mb1" }),
                getRecord: vi.fn().mockReturnValue({ actions: ["*"] }),
            },
        });
        const result = await route.escrowInfo("mb1", stranger);
        expect(result).toEqual({ escrowScopeId: "scope-1", publicKey: scope.publicKey });
    });

    it("rejects with NOT_FOUND when the mailbox has no escrow scope assigned", async () => {
        const route = buildRoute({ mailboxRepo: { findOne: vi.fn().mockResolvedValue({ ...mailbox, escrowScopeId: undefined }) } });
        await expect(route.escrowInfo("mb1", owner)).rejects.toThrow(/no resource could be found/i);
    });

    it("rejects with NOT_FOUND when the assigned escrow scope no longer exists", async () => {
        const route = buildRoute({ escrowScopeRepo: { findOne: vi.fn().mockResolvedValue(undefined) } });
        await expect(route.escrowInfo("mb1", owner)).rejects.toThrow(/no resource could be found/i);
    });
});
