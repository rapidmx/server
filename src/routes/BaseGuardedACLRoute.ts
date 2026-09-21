///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ApiError, ObjectDecorators, type JWTUser } from "@rapidrest/core";
import {
    ACLAction,
    type AccessControlList,
    ApiErrorMessages,
    ApiErrors,
    BaseACLRoute,
    type HttpRequest,
    type UpdateObject,
} from "@rapidrest/service-core";
import { hasMailAccess, USER_UID_PATTERN } from "@rapidmx/restapi";
const { Config } = ObjectDecorators;

/** The uid of the class-level ACL every mailbox's own ACL inherits from (`@Protect({ uid: "Mailbox", ... })`). */
const MAILBOX_CLASS_ACL_UID = "Mailbox";
/** How far up an ACL's parent chain to look for the mailbox class ACL (folder -> mailbox -> class -> default is 4). */
const MAX_PARENT_DEPTH = 16;

/**
 * `BaseACLRoute` (`GET/POST/PUT/DELETE /api/acls`) for a mail server: the framework's generic ACL CRUD, except that it no
 * longer lets a trusted role reach the ACLs that decide who can read somebody's mail.
 *
 * `BaseACLRoute` lets any trusted caller read and write every ACL document. Here that would be a way around the rule that
 * an administrator sees only their own mailbox and the mailboxes shared with them: `PUT /api/acls/<mailbox>` could add
 * the administrator to any mailbox's ACL, and `PUT /api/acls/Mailbox` (the class ACL every mailbox ACL inherits from)
 * could give them - or everyone - read access to all of them. So an ACL that governs mail - a mailbox's own, a folder's
 * (whose parent chain leads to a mailbox's) or the `Mailbox` class ACL itself - is treated like the mail it protects:
 * only a caller who holds `FULL` on it AS THEMSELVES (the owner, or a `manager` delegate; never through a trusted role,
 * see `hasMailAccess()`) may read or change it, and it is left out of a list. Everything else - class ACLs of other
 * models, route ACLs, ACLs of other kinds of records - stays exactly as `BaseACLRoute` has it.
 *
 * **A mail ACL only ever names user uids.** An ACL record matches a token's uid (or a role of that name) and nothing else,
 * so a grant typed in as a username (`jean-philippe`) can never apply to anyone - it left the shared mailbox `hello@`
 * without a working grant on the live host - and a username can be released and claimed by somebody else, which would
 * silently move the access. So a create or update of a mail ACL whose records name a principal that is not a (lowercase)
 * user uid is refused with 400 `No user found for "<x>".`, unless that exact record is already stored (so a full object can
 * still be saved back). `BaseMailboxAccessRoute` (`PUT /mail/mailboxes/:id/access/:principal`) is the way to grant by
 * address, username or uid: it resolves the person and stores only the uid.
 *
 * Sharing a mailbox is done through `/mail/mailboxes/:id/access` (`BaseMailboxAccessRoute`), the explicit, audited way an
 * administrator lists a mailbox's members, revokes any of them, and adds themselves to (or anyone else on) a mailbox
 * that has no owner. The `Mailbox` class ACL can be changed by no caller of this route at all: its rules come from code.
 *
 * Not covered here, deliberately: who may `POST /api/acls` a NEW ACL document is not decided by the mail rules above
 * (`BaseACLRoute`'s `checkPerms` sees route parameters only; its body's principals are checked as above) - creating an
 * ACL at a uid that already has one is refused by the framework and every mailbox and folder is created with its ACL,
 * so a new document grants nothing over existing mail.
 */
export abstract class BaseGuardedACLRoute<T extends AccessControlList> extends BaseACLRoute<T> {
    /** `trusted_roles`, the roles `BaseACLRoute` treats as superusers - never a grant on a mailbox. */
    @Config("trusted_roles", ["admin"])
    protected guardTrustedRoles: string[] = ["admin"];

    /** Whether the ACL document `uid` governs mail: it is the `Mailbox` class ACL, or its parent chain reaches it. */
    protected async isMailAcl(uid: string, parentUid?: string): Promise<boolean> {
        if (uid === MAILBOX_CLASS_ACL_UID || parentUid === MAILBOX_CLASS_ACL_UID) {
            return true;
        }
        let acl: AccessControlList | undefined = await this.aclUtils?.findACL(uid);
        for (let depth = 0; acl && depth < MAX_PARENT_DEPTH; acl = acl.parent, depth++) {
            if (acl.uid === MAILBOX_CLASS_ACL_UID) {
                return true;
            }
        }
        return false;
    }

    /** 403 unless `user` holds `FULL` on the mail ACL `uid` as themselves. */
    private async requireFullOnMailAcl(uid: string, user: JWTUser): Promise<void> {
        if (!(await hasMailAccess(this.aclUtils, this.guardTrustedRoles, user, uid, ACLAction.FULL))) {
            throw new ApiError(ApiErrors.AUTH_PERMISSION_FAILURE, 403, ApiErrorMessages.AUTH_PERMISSION_FAILURE);
        }
    }

    protected async checkPerms(params: any, user: JWTUser): Promise<void> {
        if (user && typeof params?.id === "string" && (await this.isMailAcl(params.id))) {
            await this.requireFullOnMailAcl(params.id, user);
            return;
        }
        return super.checkPerms(params, user);
    }

    protected async checkPermsBulk(objs: UpdateObject<T>[], user: JWTUser): Promise<void> {
        super.checkPermsBulk(objs, user);
        for (const obj of objs ?? []) {
            const uid: unknown = (obj as any)?.uid;
            if (typeof uid === "string" && (await this.isMailAcl(uid, (obj as any).parentUid))) {
                await this.requireFullOnMailAcl(uid, user);
            }
        }
    }

    /** 400 when `records` (a mail ACL's new records) names a principal that is neither a user uid nor already stored on `id`. */
    private async assertPrincipals(id: string, records: unknown): Promise<void> {
        if (records === undefined) {
            return;
        }
        if (!Array.isArray(records)) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, ApiErrorMessages.INVALID_REQUEST);
        }
        const stored: Set<string> = new Set(
            ((await this.aclUtils?.findACL(id, [], { skipCache: true, skipParents: true }))?.records ?? []).map((record) => record.userOrRoleId),
        );
        for (const record of records) {
            const principal: unknown = record?.userOrRoleId;
            if (typeof principal !== "string" || (!USER_UID_PATTERN.test(principal) && !stored.has(principal))) {
                throw new ApiError(ApiErrors.INVALID_REQUEST, 400, `No user found for "${String(principal)}".`);
            }
        }
    }

    public async create(obj: T | T[], req: HttpRequest, user?: JWTUser): Promise<T | T[]> {
        for (const single of Array.isArray(obj) ? obj : [obj]) {
            const uid: unknown = (single as any)?.uid;
            if (typeof uid === "string" && (await this.isMailAcl(uid, (single as any).parentUid))) {
                await this.assertPrincipals(uid, (single as any).records);
            }
        }
        return super.create(obj, req, user);
    }

    public async update(id: string, obj: UpdateObject<T>, req: HttpRequest, user?: JWTUser): Promise<T> {
        if (await this.isMailAcl(id)) {
            await this.assertPrincipals(id, (obj as any)?.records);
        }
        return super.update(id, obj, req, user);
    }

    public async updateProperty(id: string, propertyName: string, obj: any, user?: JWTUser): Promise<T> {
        if (propertyName === "records" && (await this.isMailAcl(id))) {
            await this.assertPrincipals(id, obj);
        }
        return super.updateProperty(id, propertyName, obj, user);
    }

    public async updateBulk(obj: UpdateObject<T>[], req: HttpRequest, user?: JWTUser): Promise<T[]> {
        for (const single of obj) {
            const uid: unknown = (single as any)?.uid;
            if (typeof uid === "string" && (await this.isMailAcl(uid))) {
                await this.assertPrincipals(uid, (single as any).records);
            }
        }
        return super.updateBulk(obj, req, user);
    }

    /** `BaseACLRoute.find()` without the mail ACLs the caller doesn't hold `FULL` on. */
    public async find(params: any, query: any, user?: JWTUser): Promise<T[]> {
        const found: T[] = await super.find(params, query, user);
        const visible: T[] = [];
        for (const acl of found) {
            if (
                !(await this.isMailAcl(acl.uid, acl.parentUid)) ||
                (await hasMailAccess(this.aclUtils, this.guardTrustedRoles, user, acl.uid, ACLAction.FULL))
            ) {
                visible.push(acl);
            }
        }
        return visible;
    }
}
