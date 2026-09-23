///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
import { ApiError, ObjectDecorators, type JWTUser } from "@rapidrest/core";
import { ACLAction, ACLUtils, ApiErrorMessages, ApiErrors, DocDecorators, HttpResponse, ObjectFactory, RepoUtils, RouteDecorators } from "@rapidrest/service-core";
import { AuditAction, BlobStore, hasMailAccess, isNonOwnerAccess, Mailbox, Message, recordAuditLog } from "@rapidmx/restapi";
const { Config, Inject, Logger } = ObjectDecorators;
const { Description, Summary } = DocDecorators;
const { Auth, Get, Param, RateLimit, Response, User: AuthUser } = RouteDecorators;

/**
 * Serves a message's raw RFC 5322 MIME source, byte-for-byte — the one thing `@rapidmx/restapi`'s own
 * `GET /:id/content` deliberately never does (see that route's own doc comment: it only ever serves
 * already-sanitized HTML derived from the stored MIME, since rendering raw MIME directly via a browser
 * navigation would be an XSS risk for ordinary mail).
 *
 * This exists for `specs/end-to-end_encryption.md`'s client-side decrypt/verify requirement: an
 * encrypted message's real body is never sanitized (or even visible) server-side at all — `ScanPipeline`
 * can't extract HTML from ciphertext — so the client must fetch the raw bytes itself and run
 * `@rapidmx/react-shared`'s `crypto/smimeMessage.ts` against them; the same raw bytes are also how a
 * signed (not necessarily encrypted) message's signature gets verified, since a sanitized HTML body
 * never carries the detached signature part.
 *
 * Safe as its own endpoint precisely because this server never renders the response itself and never
 * labels it as HTML (`content-type: message/rfc822`, not `text/html`) — the only caller is this app's
 * own client code (`MessageDetailPane.tsx`), which decrypts/verifies/sanitizes the result before it ever
 * touches the DOM. Mounted at the same `mail/messages` base path as `@rapidmx/restapi`'s own
 * `MessageRoute`, alongside it — the same multi-class-per-base-path pattern `KeyVaultRoute`/
 * `KeyLookupRoute`/`MailboxRoute` already use (see server's own `.claude/NOTES.md`).
 *
 * A read by anyone but the mailbox's owner (an admin or a delegate) is audited as `MESSAGE_CONTENT_ACCESSED`, exactly like
 * restapi's own `GET /:id/content`.
 */
export abstract class BaseMessageRawContentRoute<M extends Message> {
    protected abstract messageClass: any;
    protected abstract mailboxClass: any;
    protected abstract auditLogClass: any;

    // Automatically injected by ObjectFactory on instantiation
    private _objectFactory?: ObjectFactory;

    private messageRepo?: RepoUtils<M>;
    private mailboxRepo?: RepoUtils<Mailbox>;

    @Config()
    private config?: any;

    @Logger
    private logger?: any;

    @Inject("BlobStore")
    private blobStore?: BlobStore;

    @Inject(ACLUtils)
    private aclUtils?: ACLUtils;

    /** `trusted_roles`: never a grant on a mailbox - see `hasMailAccess()` in `@rapidmx/restapi`. */
    @Config("trusted_roles", ["admin"])
    private trustedRoles: string[] = ["admin"];

    private async init(): Promise<void> {
        if (!this.messageRepo) {
            this.messageRepo = await this._objectFactory!.newInstance(RepoUtils, {
                name: this.messageClass.name,
                args: [this.messageClass],
            });
        }
        if (!this.mailboxRepo) {
            this.mailboxRepo = await this._objectFactory!.newInstance(RepoUtils, {
                name: this.mailboxClass.name,
                args: [this.mailboxClass],
            });
        }
    }

    @Summary("Get a message's raw MIME source")
    @Description(
        "Streams the message's raw RFC 5322 MIME source, completely unmodified, for client-side E2E " +
            "decrypt/signature-verification use only. Never sanitized - callers must never render this " +
            "directly (see GET /:id/content for the sanitized HTML every other view uses).",
    )
    @Auth(["jwt"])
    // Unlike most routes, which fall to the generous "authenticated" tier (~10k req/300s), this one loads a whole raw
    // MIME blob into memory per request - up to mail:compose:max_attachment_bytes (25MB default) for a composed
    // message, and unbounded for inbound mail. A real user fetches this a handful of times per message they actually
    // decrypt/verify, not per page view, so 300/min (matching BaseGiphySearchRoute's own per-user cap for its other
    // expensive, per-request-cost route) is generous headroom over real usage while bounding a mass-download abuse case.
    @RateLimit({ perUser: true, maxAttempts: 300, windowSeconds: 60 })
    @Get("/:id/raw")
    public async raw(@Param("id") id: string, @Response res: HttpResponse, @AuthUser user?: JWTUser): Promise<void> {
        if (!this.blobStore || !this.aclUtils) {
            throw new ApiError(ApiErrors.INTERNAL_ERROR, 500, ApiErrorMessages.INTERNAL_ERROR);
        }
        await this.init();

        const message: M | undefined = await this.messageRepo!.findOne(id, { ignoreACL: true });
        if (!message || !(await hasMailAccess(this.aclUtils, this.trustedRoles, user, message.folderUid, ACLAction.READ))) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }
        if (!message.bodyBlobKey) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }

        // An unresolvable mailbox counts as non-owner access (restapi's content() does the same): the bytes are served
        // either way, so the uncertain case is audited rather than skipped.
        const mailbox: Mailbox | undefined = await this.mailboxRepo!.findOne(message.mailboxUid, { ignoreACL: true });
        if (!mailbox || isNonOwnerAccess(mailbox, user)) {
            await recordAuditLog(
                this._objectFactory!,
                this.auditLogClass,
                { config: this.config, user, logger: this.logger },
                {
                    action: AuditAction.MESSAGE_CONTENT_ACCESSED,
                    targetType: "Message",
                    targetUid: message.uid,
                    mailboxUid: message.mailboxUid,
                    details: { subject: message.subject, raw: true },
                },
            );
        }

        const raw: Buffer = await this.blobStore.get(message.bodyBlobKey);
        res.setHeader("content-type", "message/rfc822");
        // Matches every other file-serving path in this repo (BaseStaticAssetRoute, staticAssets.ts): this is raw,
        // unsanitized RFC 5322 MIME source, so a browser must never be allowed to sniff/render it as HTML.
        res.setHeader("x-content-type-options", "nosniff");
        res.send(raw);
    }
}
