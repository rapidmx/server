///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
import { ApiError, ObjectDecorators, type JWTUser } from "@rapidrest/core";
import { ACLAction, ACLUtils, ApiErrorMessages, ApiErrors, DocDecorators, ObjectFactory, RepoUtils, RouteDecorators } from "@rapidrest/service-core";
import { EscrowScope, EscrowScopePublicKey, Mailbox } from "@rapidmx/restapi";
const { Inject } = ObjectDecorators;
const { Description, Summary } = DocDecorators;
const { Auth, Get, Param, User: AuthUser } = RouteDecorators;

export interface EscrowInfo {
    escrowScopeId: string;
    publicKey: EscrowScopePublicKey;
}

/**
 * A narrow, mailbox-owner-readable alternative to `@rapidmx/restapi`'s own `GET /escrow-scopes/:id`
 * (trusted-admin-only, by design - see `BaseEscrowScopeRoute`'s own doc comment: configuring *who counts
 * as a holder* is an administrative act). A mailbox assigned to an `EscrowScope` (`Mailbox.escrowScopeId`,
 * itself an admin-only action - see `BaseMailboxRoute.validateEscrowScopeAssignment()`) has no
 * restapi-provided way for its owner to read that scope's public key at all, yet needs exactly that to
 * wrap their own master key against it (`specs/end-to-end_encryption.md`'s escrow step - see
 * `crypto/keyvaultApi.ts`'s `addMasterKeyWrap()`/`MasterKeyWrap{method:"escrow"}`, and
 * `BaseKeyVaultRoute.resolveAllowEscrow()`, which is the only place such a wrap can actually be
 * persisted). This route reads the *one* `EscrowScope` the caller's own mailbox is already assigned to,
 * directly via `RepoUtils` (deliberately bypassing `BaseEscrowScopeRoute`'s trusted-only gate), and
 * returns only `{escrowScopeId, publicKey}` - never a list of scopes, never holder identities, never any
 * other scope's data. Same "server fills a gap restapi's own routes don't cover" precedent as
 * `BaseMessageRawContentRoute`.
 *
 * Access is gated the same way `BaseKeyVaultRoute`'s own encryption-adjacent endpoints are - owner or an
 * explicit ACL grant, with no trusted-role bypass (a system admin with no grant on this specific mailbox
 * gets the same 403 as anyone else) - see this class's own `requireMailboxAccess()`, a deliberate copy of
 * `BaseKeyVaultRoute`'s private method of the same name (not reusable across packages, and small enough
 * not to be worth a shared-utility round-trip through restapi for).
 */
export abstract class BaseEscrowInfoRoute<M extends Mailbox> {
    protected abstract mailboxClass: any;
    protected abstract escrowScopeClass: any;

    // Automatically injected by ObjectFactory on instantiation
    private _objectFactory?: ObjectFactory;

    private mailboxRepo?: RepoUtils<M>;
    private escrowScopeRepo?: RepoUtils<EscrowScope>;

    @Inject(ACLUtils)
    private aclUtils?: ACLUtils;

    private async init(): Promise<void> {
        if (!this.mailboxRepo) {
            this.mailboxRepo = await this._objectFactory!.newInstance(RepoUtils, {
                name: this.mailboxClass.name,
                args: [this.mailboxClass],
            });
        }
        if (!this.escrowScopeRepo) {
            this.escrowScopeRepo = await this._objectFactory!.newInstance(RepoUtils, {
                name: this.escrowScopeClass.name,
                args: [this.escrowScopeClass],
            });
        }
    }

    /** See this class's own doc comment on why `ACLUtils.hasPermission()` (with its unconditional
     * trusted-role bypass) is never used here - a direct copy of `BaseKeyVaultRoute`'s identically-named
     * private method. */
    private async requireMailboxAccess(mailbox: M, user: JWTUser | undefined): Promise<void> {
        if (user && mailbox.ownerUserUid === user.uid) {
            return;
        }
        const acl = await this.aclUtils!.findACL(mailbox.uid);
        const record = acl ? this.aclUtils!.getRecord(acl, user) : null;
        if (record && (record.actions.includes(ACLAction.READ) || record.actions.includes(ACLAction.FULL))) {
            return;
        }
        throw new ApiError(ApiErrors.AUTH_PERMISSION_FAILURE, 403, ApiErrorMessages.AUTH_PERMISSION_FAILURE);
    }

    @Summary("Get this mailbox's assigned escrow scope's public key")
    @Description(
        "Returns only {escrowScopeId, publicKey} for the EscrowScope this mailbox is currently assigned " +
            "to (Mailbox.escrowScopeId), so its owner can wrap their master key against it. 404 if the " +
            "mailbox has no escrow scope assigned, or doesn't exist, or the caller can't access it. Never " +
            "exposes holder identities or any other scope's data.",
    )
    @Auth(["jwt"])
    @Get("/:id/escrow-info")
    public async escrowInfo(@Param("id") mailboxId: string, @AuthUser user?: JWTUser): Promise<EscrowInfo> {
        if (!this.aclUtils) {
            throw new ApiError(ApiErrors.INTERNAL_ERROR, 500, ApiErrorMessages.INTERNAL_ERROR);
        }
        await this.init();

        const mailbox: M | undefined = await this.mailboxRepo!.findOne(mailboxId, { ignoreACL: true });
        if (!mailbox) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }
        await this.requireMailboxAccess(mailbox, user);

        if (!mailbox.escrowScopeId) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }
        const scope: EscrowScope | undefined = await this.escrowScopeRepo!.findOne(mailbox.escrowScopeId, { ignoreACL: true });
        if (!scope) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }

        return { escrowScopeId: mailbox.escrowScopeId, publicKey: scope.publicKey };
    }
}
