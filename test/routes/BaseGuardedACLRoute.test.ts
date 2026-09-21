///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
// `/api/acls` without the trusted-role bypass for the ACLs that decide who reads somebody's mail. Mocked at the ACL
// boundary (no database): `hasPermission` stands in for the framework's - yes to a trusted role, else only what the
// record says - so a route that handed it the caller as-is would let an administrator in.
import config from "../../src/config.mongo.js";
import { ObjectFactory } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import { BaseGuardedACLRoute } from "../../src/routes/BaseGuardedACLRoute.js";

class TestACLRoute extends BaseGuardedACLRoute<any> {
    protected modelClass: any = class {};
}

/** ACLs by uid: a mailbox's (parent `Mailbox`), a folder's (parent the mailbox), a platform one (parent `default_Setting`). */
const ACLS: Record<string, any> = {
    "owner@example.com": { uid: "owner@example.com", parentUid: "Mailbox", records: [{ userOrRoleId: "owner-uid", actions: ["*"] }] },
    folder1: { uid: "folder1", parentUid: "owner@example.com", records: [] },
    Mailbox: { uid: "Mailbox", parentUid: "default_Mailbox", records: [] },
    Setting: { uid: "Setting", parentUid: "default_Setting", records: [] },
};
ACLS["folder1"].parent = { ...ACLS["owner@example.com"], parent: { ...ACLS["Mailbox"] } };
ACLS["owner@example.com"].parent = ACLS["Mailbox"];

const owner: any = { uid: "owner-uid", roles: [], scopes: [] };
const admin: any = { uid: "admin-uid", roles: ["admin"], scopes: [], elevated: Date.now() };

describe("BaseGuardedACLRoute", () => {
    const objectFactory: ObjectFactory = new ObjectFactory(config, Logger());

    function buildRoute(): { route: any; hasPermission: ReturnType<typeof vi.fn> } {
        const route: any = objectFactory.newInstance<TestACLRoute>(TestACLRoute, { initialize: false });
        // The framework: yes to a trusted role, else FULL for the owner's uid on the mailbox and what inherits from it.
        const hasPermission = vi.fn(async (user: any, uid: string) => {
            if (user?.roles?.includes("admin")) {
                return true;
            }
            return user?.uid === "owner-uid" && (uid === "owner@example.com" || uid === "folder1");
        });
        route.aclUtils = { hasPermission, findACL: vi.fn(async (uid: string) => ACLS[uid]) };
        route.config = { get: (key: string) => (key === "trusted_roles" ? ["admin"] : undefined) };
        route.guardTrustedRoles = ["admin"];
        return { route, hasPermission };
    }

    describe("checkPerms()", () => {
        it("Refuses an administrator any ACL that governs mail: a mailbox's, a folder's, and the Mailbox class ACL.", async () => {
            const { route } = buildRoute();
            for (const id of ["owner@example.com", "folder1", "Mailbox"]) {
                await expect(route.checkPerms({ id }, admin), id).rejects.toMatchObject({ status: 403 });
            }
        });

        it("Lets whoever holds FULL on a mailbox's ACL as themselves - the owner - manage it and its folders', but nobody the class ACL.", async () => {
            const { route } = buildRoute();
            await expect(route.checkPerms({ id: "owner@example.com" }, owner)).resolves.toBeUndefined();
            await expect(route.checkPerms({ id: "folder1" }, owner)).resolves.toBeUndefined();
            await expect(route.checkPerms({ id: "Mailbox" }, owner)).rejects.toMatchObject({ status: 403 });
        });

        it("Leaves every other ACL to BaseACLRoute: a trusted caller may manage it, an ordinary one may not, and nobody is a 401.", async () => {
            const { route } = buildRoute();
            await expect(route.checkPerms({ id: "Setting" }, admin)).resolves.toBeUndefined();
            await expect(route.checkPerms({}, admin)).resolves.toBeUndefined();
            await expect(route.checkPerms({ id: "Setting" }, owner)).rejects.toMatchObject({ status: 403 });
            await expect(route.checkPerms({ id: "Setting" }, undefined)).rejects.toMatchObject({ status: 401 });
        });

        it("Treats an ACL that doesn't exist like any other one - it governs no mail.", async () => {
            const { route } = buildRoute();
            await expect(route.checkPerms({ id: "nothing-here" }, admin)).resolves.toBeUndefined();
        });
    });

    describe("checkPermsBulk()", () => {
        it("Refuses a bulk update naming a mail ACL - by uid, or by a parent that is the Mailbox class ACL - unless the caller holds FULL on it.", async () => {
            const { route } = buildRoute();
            await expect(route.checkPermsBulk([{ uid: "owner@example.com" }], admin)).rejects.toMatchObject({ status: 403 });
            await expect(route.checkPermsBulk([{ uid: "fresh", parentUid: "Mailbox" }], admin)).rejects.toMatchObject({ status: 403 });
            await expect(route.checkPermsBulk([{ uid: "owner@example.com" }], owner)).rejects.toMatchObject({ status: 403 });
        });

        it("Leaves a bulk update of other ACLs to BaseACLRoute (trusted only, never a default_ one).", async () => {
            const { route } = buildRoute();
            await expect(route.checkPermsBulk([{ uid: "Setting" }, { name: "no uid" }], admin)).resolves.toBeUndefined();
            await expect(route.checkPermsBulk(undefined, admin)).resolves.toBeUndefined();
            await expect(route.checkPermsBulk([{ uid: "Setting" }], owner)).rejects.toMatchObject({ status: 403 });
            await expect(route.checkPermsBulk([{ uid: "default_Setting" }], admin)).rejects.toMatchObject({ status: 403 });
        });
    });

    describe("principals of a mail ACL (update, updateProperty, updateBulk, create)", () => {
        const UID = "94337e42-0898-4be3-9d82-b9777388b238";
        const base = Object.getPrototypeOf(Object.getPrototypeOf(TestACLRoute.prototype));
        const req: any = {};

        afterEach(() => {
            vi.restoreAllMocks();
        });

        it("Refuses a record naming a username, an address or an uppercase uid (400 No user found) and passes a user uid - on every write path.", async () => {
            const { route } = buildRoute();
            const update = vi.spyOn(base, "update").mockResolvedValue({ uid: "owner@example.com" });
            const property = vi.spyOn(base, "updateProperty").mockResolvedValue({ uid: "owner@example.com" });
            const bulk = vi.spyOn(base, "updateBulk").mockResolvedValue([]);
            const create = vi.spyOn(base, "create").mockResolvedValue({ uid: "x" });
            const bad = [{ userOrRoleId: "jean-philippe", actions: ["read"] }];
            const good = [{ userOrRoleId: UID, actions: ["read"] }];

            for (const principal of ["jean-philippe", "jp@example.org", UID.toUpperCase(), ".*", "support"]) {
                const records = [{ userOrRoleId: principal, actions: ["read"] }];
                await expect(route.update("owner@example.com", { records }, req, owner), principal).rejects.toMatchObject({ status: 400, message: `No user found for "${principal}".` });
            }
            await expect(route.update("owner@example.com", { records: bad }, req, owner)).rejects.toMatchObject({ status: 400 });
            await expect(route.updateProperty("owner@example.com", "records", bad, owner)).rejects.toMatchObject({ status: 400 });
            await expect(route.updateBulk([{ uid: "folder1", records: bad }], req, owner)).rejects.toMatchObject({ status: 400 });
            await expect(route.create({ uid: "fresh", parentUid: "Mailbox", records: bad }, req, owner)).rejects.toMatchObject({ status: 400 });
            await expect(route.create([{ uid: "fresh", parentUid: "Mailbox", records: [{ actions: [] }] }], req, owner)).rejects.toMatchObject({ status: 400 });
            expect(update).not.toHaveBeenCalled();

            await route.update("owner@example.com", { records: good }, req, owner);
            await route.updateProperty("owner@example.com", "records", good, owner);
            await route.updateBulk([{ uid: "folder1", records: good }], req, owner);
            await route.create({ uid: "fresh", parentUid: "Mailbox", records: good }, req, owner);
            expect([update.mock.calls.length, property.mock.calls.length, bulk.mock.calls.length, create.mock.calls.length]).toEqual([1, 1, 1, 1]);
        });

        it("Lets a full object be saved back - a record already stored on the ACL is accepted as it is - and a body with no records at all.", async () => {
            const { route } = buildRoute();
            const update = vi.spyOn(base, "update").mockResolvedValue({ uid: "owner@example.com" });
            ACLS["owner@example.com"].records.push({ userOrRoleId: "legacy-name", actions: ["read"] });
            try {
                await route.update("owner@example.com", { records: [{ userOrRoleId: "owner-uid", actions: ["*"] }, { userOrRoleId: "legacy-name", actions: ["read"] }] }, req, owner);
                await route.update("owner@example.com", { version: 3 }, req, owner);
                await expect(route.update("owner@example.com", { records: "nope" }, req, owner)).rejects.toMatchObject({ status: 400 });
                expect(update).toHaveBeenCalledTimes(2);
            } finally {
                ACLS["owner@example.com"].records.pop();
            }
        });

        it("Leaves the principals of any other ACL alone - a role name is fine on a route or class ACL.", async () => {
            const { route } = buildRoute();
            const update = vi.spyOn(base, "update").mockResolvedValue({ uid: "Setting" });
            const property = vi.spyOn(base, "updateProperty").mockResolvedValue({ uid: "Setting" });
            const bulk = vi.spyOn(base, "updateBulk").mockResolvedValue([]);
            const create = vi.spyOn(base, "create").mockResolvedValue({ uid: "y" });
            const records = [{ userOrRoleId: "support", actions: ["read"] }];
            await route.update("Setting", { records }, req, admin);
            await route.updateProperty("Setting", "records", records, admin);
            await route.updateProperty("owner@example.com", "version", 3, owner);
            await route.updateBulk([{ uid: "Setting", records }, { name: "no uid" }], req, admin);
            await route.create([{ uid: "other", records }, { name: "no uid" }], req, admin);
            expect([update.mock.calls.length, property.mock.calls.length, bulk.mock.calls.length, create.mock.calls.length]).toEqual([1, 2, 1, 1]);
        });
    });

    describe("find()", () => {
        it("Leaves the mail ACLs out of an administrator's list - and shows an owner their own.", async () => {
            const { route } = buildRoute();
            const all: any[] = [ACLS["owner@example.com"], ACLS["folder1"], ACLS["Mailbox"], ACLS["Setting"]];
            vi.spyOn(Object.getPrototypeOf(Object.getPrototypeOf(TestACLRoute.prototype)), "find").mockResolvedValue(all);

            expect((await route.find({}, {}, admin)).map((acl: any) => acl.uid)).toEqual(["Setting"]);
            expect((await route.find({}, {}, owner)).map((acl: any) => acl.uid)).toEqual(["owner@example.com", "folder1", "Setting"]);
            vi.restoreAllMocks();
        });
    });
});
