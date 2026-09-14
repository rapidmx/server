///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
import * as crypto from "crypto";
import sanitizeHtml from "sanitize-html";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import addressparser from "nodemailer/lib/addressparser/index.js";
import { ApiError, ObjectDecorators, type JWTUser } from "@rapidrest/core";
import {
    ACLAction,
    ACLUtils,
    ApiErrorMessages,
    ApiErrors,
    BaseEntity,
    DocDecorators,
    ObjectFactory,
    RepoUtils,
    RouteDecorators,
} from "@rapidrest/service-core";
import { Attachment, BlobStore, Folder, FolderType, Mailbox, Matter, Message, Recipient, RecipientType } from "@rapidmx/restapi";
import { DEFAULT_MAX_COMPOSE_ATTACHMENT_BYTES } from "../config.defaults.js";
const { Config, Inject } = ObjectDecorators;
const { Description, Returns, Summary } = DocDecorators;
const { Auth, Param, Post, User: AuthUser } = RouteDecorators;

/**
 * The structured compose input a webmail client submits — see `assembleDraft()` in `@rapidmx/react-shared`'s `mailApi.ts`.
 * `to` and `html` may be empty: the client autosaves (and saves on Close and sign-out) through this route, so a draft
 * typed before any recipient is added, or with an empty body, must still be stored. Sending needs recipients, which
 * the client checks before calling send.
 */
export interface ComposeAssembleInput {
    to?: Recipient[];
    cc?: Recipient[];
    bcc?: Recipient[];
    subject?: string;
    html?: string;
}

/**
 * The already-fully-composed input a webmail client submits for an E2E signed and/or encrypted
 * message — see `assembleDraftRaw()` in `@rapidmx/react-shared`'s `mailApi.ts`. Unlike
 * `ComposeAssembleInput`, there is no HTML body for this server to sanitize or compose into MIME:
 * `specs/end-to-end_encryption.md`'s "Digital Signatures" section requires signing to be "the final
 * step before submission," since "any downstream process that normalises whitespace, re-wraps lines
 * or re-encodes the body will invalidate the signature" — real crypto (signing/encryption) happens
 * entirely client-side (`@rapidmx/react-shared`'s `crypto/smimeMessage.ts`), and this server only
 * ever stores the resulting bytes completely unmodified.
 */
export interface ComposeAssembleRawInput {
    to: Recipient[];
    cc?: Recipient[];
    bcc?: Recipient[];
    /** The message's own top-level `Subject` — for an encrypted message this is the OUTER, RFC
     * 9788 `hcp_baseline`-obscured value (`"[...]"`), matching what the client already put in the raw
     * MIME's own outer `Subject:` header; this server never sees (and must never be trusted to
     * recompute) the real one. */
    subject: string;
    /** The complete RFC 5322 message source, already finalized (signed/encrypted, if applicable)
     * client-side — stored byte-for-byte as this draft's `bodyBlobKey`, never rewritten. Only its top-level
     * headers are read, to check From/Sender/To/Cc against the mailbox and recipients (`assertRawMimeHeadersMatch()`).
     * File attachments are not yet supported on this path (a signed/encrypted message can only
     * contain a text body) — see this route's own `assembleRaw()` doc comment. */
    rawMime: string;
}

/** The blob key prefix of a composed draft body. */
const COMPOSED_BODY_PREFIX = "bodies/";

function toNodemailerAddress(recipient: Recipient): { name?: string; address: string } {
    return { name: recipient.displayName, address: recipient.address };
}

/**
 * The mailbox display name to put in a composed `From` header, or `undefined` for a bare address: a name containing
 * `@` looks like a different sender's address to the recipient (restapi refuses to send such a message, and now rejects
 * such names, but existing mailboxes may still have one), and CR/LF has no place in a header.
 */
export function safeFromDisplayName(displayName: string | undefined): string | undefined {
    const name: string = (displayName ?? "").trim();
    return name && !/[@\r\n]/.test(name) ? name : undefined;
}

function isRecipientList(value: unknown): value is Recipient[] | undefined {
    return (
        value === undefined ||
        (Array.isArray(value) && value.every((r) => r && typeof r === "object" && typeof (r as Recipient).address === "string"))
    );
}

function invalidRawMime(reason: string): ApiError {
    return new ApiError(ApiErrors.INVALID_REQUEST, 400, `The raw message is invalid: ${reason}`);
}

/**
 * The top-level header fields of an RFC 5322 message, lower-cased name -> every value in order (unfolded). Only the
 * header block is read; the body - which may be signed or encrypted - is never touched.
 */
export function parseTopLevelHeaders(rawMime: string): Map<string, string[]> {
    const end: RegExpExecArray | null = /\r?\n\r?\n/.exec(rawMime);
    const block: string = end ? rawMime.slice(0, end.index) : rawMime;
    const headers = new Map<string, string[]>();
    let last: { name: string; index: number } | undefined;
    for (const line of block.split(/\r?\n/)) {
        if (/^[ \t]/.test(line)) {
            if (!last) {
                throw invalidRawMime("it starts with a folded header line.");
            }
            const values: string[] = headers.get(last.name)!;
            values[last.index] += ` ${line.trim()}`;
            continue;
        }
        const match: RegExpMatchArray | null = line.match(/^([!-9;-~]+):(.*)$/);
        if (!match) {
            throw invalidRawMime("it has a malformed header line.");
        }
        const name: string = match[1].toLowerCase();
        const values: string[] = headers.get(name) ?? [];
        values.push(match[2].trim());
        headers.set(name, values);
        last = { name, index: values.length - 1 };
    }
    return headers;
}

function headerAddresses(values: string[] | undefined): string[] {
    return (values ?? []).flatMap((value) => addressparser(value, { flatten: true }).map((a) => (a.address ?? "").trim().toLowerCase()));
}

function sameAddressSet(a: string[], b: string[]): boolean {
    const left = new Set(a);
    const right = new Set(b);
    return left.size === right.size && [...left].every((address) => right.has(address));
}

/** Decodes RFC 2047 encoded-words (`=?charset?B|Q?...?=`) in a display name; whitespace between two encoded-words is dropped. */
export function decodeEncodedWords(value: string): string {
    return value
        .replace(/(=\?[^?\s]+\?[bBqQ]\?[^?\s]*\?=)\s+(?==\?[^?\s]+\?[bBqQ]\?[^?\s]*\?=)/g, "$1")
        .replace(/=\?([^?\s]+)\?([bBqQ])\?([^?\s]*)\?=/g, (word, charset: string, encoding: string, text: string) => {
            try {
                const bytes: Buffer =
                    encoding.toUpperCase() === "B"
                        ? Buffer.from(text, "base64")
                        : Buffer.from(
                            text.replace(/_/g, " ").replace(/=([0-9a-fA-F]{2})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16))),
                            "latin1",
                        );
                // RFC 2231 allows a language suffix (`utf-8*en`).
                return new TextDecoder(charset.split("*")[0], { fatal: true }).decode(bytes);
            } catch {
                return word;
            }
        });
}

/**
 * Trace and authentication headers only a receiving/relaying system may write. A client-composed message carrying one
 * would be relayed with it, and a downstream system - including this server's own ingest for local recipients - could
 * trust it: forged `Authentication-Results` would pass DKIM-aligned checks (iTIP, recalls, ACME), a forged
 * `RapidMX-Key` header would announce a key for the sender, and `X-RapidMX-*` headers are this server's own markers.
 */
function isTrustHeader(name: string): boolean {
    return (
        ["authentication-results", "dkim-signature", "received", "received-spf", "return-path"].includes(name) ||
        name.startsWith("arc-") ||
        name.startsWith("rapidmx-key") ||
        name.startsWith("x-rapidmx-")
    );
}

/**
 * Checks a raw `From`/`Sender` value is exactly one mailbox of `own`, with no display name other than the mailbox's own.
 * addressparser is lenient: `bob@evil.com <alice@example.com>` or `Alice <alice@example.com> <x@y.com>` both parse as
 * alice with the rest folded into the name, which a recipient's client would show. So beyond the parsed result, the raw
 * value (quoted strings removed) may hold at most one angle-bracket address and exactly one `@`.
 */
function isOwnSingleMailbox(values: string[] | undefined, own: Set<string>, displayName: string): boolean {
    if (values?.length !== 1) {
        return false;
    }
    const unquoted: string = values[0].replace(/"(?:[^"\\]|\\.)*"/g, '""');
    if ((unquoted.match(/</g) ?? []).length > 1 || (unquoted.match(/>/g) ?? []).length > 1 || (unquoted.match(/@/g) ?? []).length !== 1) {
        return false;
    }
    const parsed = addressparser(values[0]);
    if (parsed.length !== 1 || (parsed[0] as any).group || !own.has((parsed[0].address ?? "").trim().toLowerCase())) {
        return false;
    }
    const name: string = decodeEncodedWords(parsed[0].name ?? "").trim();
    return name === "" || name === displayName;
}

/**
 * Checks a client-composed (signed/encrypted) message's own top-level headers against what the server knows, since the
 * stored bytes are relayed unchanged: `From` must be exactly one of the sending mailbox's own addresses (primary or
 * alias) with no display name or the mailbox's own, a `Sender` likewise, `To`/`Cc` must list exactly the recipients the
 * draft is sent to, and no `Bcc`, `Resent-*` or trace/authentication header (`isTrustHeader()`) may be present (Bcc
 * recipients are submitted separately and must never appear in the message).
 *
 * @throws `ApiError` 400 describing the first mismatch.
 */
export function assertRawMimeHeadersMatch(
    rawMime: string,
    mailbox: Pick<Mailbox, "primarySmtpAddress" | "aliasAddresses"> & { displayName?: string },
    body: Pick<ComposeAssembleRawInput, "to" | "cc">,
): void {
    const headers: Map<string, string[]> = parseTopLevelHeaders(rawMime);
    const own = new Set(
        [mailbox.primarySmtpAddress, ...(mailbox.aliasAddresses ?? [])].filter(Boolean).map((a) => a.trim().toLowerCase()),
    );
    // Only a name the server itself would write (see `safeFromDisplayName()`); send refuses an address-like one anyway.
    const displayName: string = safeFromDisplayName(mailbox.displayName) ?? "";

    if (headers.has("bcc")) {
        throw invalidRawMime("it must not contain a Bcc header.");
    }
    if ([...headers.keys()].some((name) => name.startsWith("resent-"))) {
        throw invalidRawMime("it must not contain Resent-* headers.");
    }
    const trustHeader: string | undefined = [...headers.keys()].find(isTrustHeader);
    if (trustHeader) {
        throw invalidRawMime(`it must not contain a ${trustHeader} header - only a receiving or relaying server may add one.`);
    }
    if (!isOwnSingleMailbox(headers.get("from"), own, displayName)) {
        throw invalidRawMime("its From header must be a single address belonging to this mailbox, with no display name but the mailbox's own.");
    }
    if (headers.has("sender") && !isOwnSingleMailbox(headers.get("sender"), own, displayName)) {
        throw invalidRawMime("its Sender header must be a single address belonging to this mailbox, with no display name but the mailbox's own.");
    }
    const lower = (recipients?: Recipient[]): string[] => (recipients ?? []).map((r) => r.address.trim().toLowerCase());
    if (!sameAddressSet(headerAddresses(headers.get("to")), lower(body.to))) {
        throw invalidRawMime("its To header doesn't match the draft's To recipients.");
    }
    if (!sameAddressSet(headerAddresses(headers.get("cc")), lower(body.cc))) {
        throw invalidRawMime("its Cc header doesn't match the draft's Cc recipients.");
    }
}

/**
 * `assemble()` is the one place a webmail client's own HTML — never sanitized client-side against anything
 * a malicious/compromised browser extension or a bug in the rich-text editor could produce — reaches this
 * server on its way into a real outbound MIME message and this draft's stored preview text. Unlike inbound
 * mail (sanitized by `@rapidmx/restapi`'s own `ScanPipeline.sanitize()`, via the same `sanitize-html`
 * library, before ever being rendered back to a browser), nothing upstream of this route sanitizes outbound
 * compose input at all — this is the sole gate. Allowlist covers exactly what `RichTextEditor`'s configured
 * TipTap extensions can actually produce (`apps/shared/components/mail/compose/RichTextEditor.tsx`): basic
 * formatting/structure tags, `style` attributes for `TextStyleKit`'s color/font-family/font-size and
 * `TextAlign`'s alignment (deliberately allowlisted by property+value pattern, not left wide open — an
 * unrestricted `style` attribute is its own injection surface), links/images (`cid:` allowed since an
 * inline image could reference an already-uploaded attachment by Content-ID), and tables.
 */
export function sanitizeComposeHtml(html: string): string {
    return sanitizeHtml(html, {
        allowedTags: [
            "p",
            "br",
            "hr",
            "h1",
            "h2",
            "h3",
            "h4",
            "h5",
            "h6",
            "strong",
            "em",
            "u",
            "s",
            "mark",
            "ul",
            "ol",
            "li",
            "blockquote",
            "pre",
            "code",
            "a",
            "img",
            "table",
            "thead",
            "tbody",
            "tr",
            "th",
            "td",
            "span",
        ],
        allowedAttributes: {
            a: ["href", "target", "rel"],
            img: ["src", "alt", "title", "width", "height"],
            "*": ["style"],
        },
        allowedStyles: {
            "*": {
                color: [/^#[0-9a-f]{3,8}$/i, /^rgb\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*\)$/i],
                "background-color": [/^#[0-9a-f]{3,8}$/i, /^rgb\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*\)$/i],
                "font-family": [/^[-,'"a-z0-9\s]+$/i],
                "font-size": [/^\d+(?:\.\d+)?(?:px|em|rem|%)$/],
                "text-align": [/^(?:left|right|center|justify)$/],
            },
        },
        allowedSchemes: ["http", "https", "mailto", "cid"],
        allowVulnerableTags: false,
        disallowedTagsMode: "discard",
    });
}

/**
 * Rewrites `<img>` references to this draft's own already-uploaded attachments (by their
 * `/mail/attachments/:uid/content` URL — see `attachmentContentUrl()` in `@rapidmx/react-shared`'s `mailApi.ts`)
 * into `cid:` references instead, matching each attachment's own `contentId`.
 *
 * The client's rich-text editor can't render a `cid:` URL at all (browsers only resolve that scheme
 * inside an actual MIME-rendering mail client, never a live DOM) — so while composing, an inserted
 * image points at this server's own authenticated content endpoint instead, which the browser *can*
 * fetch, for a working live preview. That URL is meaningless outside this server, though (a
 * recipient's mail client has no session cookie to fetch it with), so it's rewritten to the `cid:`
 * form the message actually ships with here, at assemble time — after this point, `attachments` is
 * always built with that same `contentId` as each attachment's own MIME `cid` (see below), so a
 * rewritten reference always resolves for the recipient.
 */
export function rewriteInlineImageSources(html: string, attachments: { uid: string; contentId?: string }[]): string {
    let result = html;
    for (const attachment of attachments) {
        if (!attachment.contentId) {
            continue;
        }
        result = result.split(`/api/mail/attachments/${attachment.uid}/content`).join(`cid:${attachment.contentId}`);
    }
    return result;
}

/** A short, tag-stripped plain-text preview, mirroring how `@rapidmx/restapi`'s own ingestion pipeline derives `bodyPreview`. */
function toPreview(html: string): string {
    return html
        .replace(/<[^>]*>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 200);
}

/**
 * `mail-server`-local glue between the webmail compose UI and `@rapidmx/restapi`'s `BaseMessageRoute.send()`.
 *
 * `BaseMessageRoute.send()` deliberately does no MIME composition of its own — it expects a draft's
 * `bodyBlobKey` to already hold fully-assembled RFC 5322 source (see its doc comment) — because the library
 * has no opinion on how a caller composes a message (a webmail client, EAS's `ComposeMailCommand`, and MAPI's
 * `RopSubmitMessageHandler` all build MIME differently, from different starting inputs). This route is that
 * assembly step for the webmail client specifically: it turns structured `{to, cc, bcc, subject, html}` input
 * plus whatever `Attachment`s have already been uploaded against the draft (via the library's own
 * `BaseAttachmentRoute.upload`) into raw MIME via `nodemailer`'s `MailComposer` — the same serializer
 * `RopSubmitMessageHandler` already uses elsewhere in this library family for exactly this purpose — then
 * saves it back onto the draft. It does not send anything; the client still calls the library's own
 * `POST /messages/:id/send` afterward.
 *
 * The draft's `from` is always derived from its owning `Mailbox` (never taken from the client), so this
 * cannot be used to spoof a `From` address the caller's mailbox doesn't actually own.
 *
 * `messageClass`/`attachmentClass`/`mailboxClass`/`folderClass`/`matterClass` are supplied by the Mongo/SQL concrete
 * subclasses.
 */
export abstract class BaseMailComposeRoute<M extends Message, A extends Attachment, X extends Mailbox, F extends Folder> {
    protected abstract messageClass: any;
    protected abstract attachmentClass: any;
    protected abstract mailboxClass: any;
    protected abstract folderClass: any;
    protected abstract matterClass: any;

    // Automatically injected by ObjectFactory on instantiation
    private _objectFactory?: ObjectFactory;

    private messageRepo?: RepoUtils<M>;
    private attachmentRepo?: RepoUtils<A>;
    private mailboxRepo?: RepoUtils<X>;
    private folderRepo?: RepoUtils<F>;
    private matterRepo?: RepoUtils<any>;

    @Inject("BlobStore")
    private blobStore?: BlobStore;

    @Inject(ACLUtils)
    private aclUtils?: ACLUtils;

    @Config()
    private config?: { get(key: string): unknown };

    private async init(): Promise<void> {
        if (!this.messageRepo) {
            this.messageRepo = await this._objectFactory!.newInstance(RepoUtils, {
                name: this.messageClass.name,
                args: [this.messageClass],
            });
        }
        if (!this.attachmentRepo) {
            this.attachmentRepo = await this._objectFactory!.newInstance(RepoUtils, {
                name: this.attachmentClass.name,
                args: [this.attachmentClass],
            });
        }
        if (!this.mailboxRepo) {
            this.mailboxRepo = await this._objectFactory!.newInstance(RepoUtils, {
                name: this.mailboxClass.name,
                args: [this.mailboxClass],
            });
        }
        if (!this.folderRepo) {
            this.folderRepo = await this._objectFactory!.newInstance(RepoUtils, {
                name: this.folderClass.name,
                args: [this.folderClass],
            });
        }
        if (!this.matterRepo) {
            this.matterRepo = await this._objectFactory!.newInstance(RepoUtils, {
                name: this.matterClass.name,
                args: [this.matterClass],
            });
        }
    }

    @Summary("Assemble compose draft into MIME")
    @Description(
        "Builds RFC 5322 MIME from structured compose input (recipients/subject/HTML body, plus whatever " +
            "attachments have already been uploaded against this draft) and stores it as the draft's " +
            "bodyBlobKey — does NOT send it. Call POST /messages/:id/send afterward to relay it.",
    )
    @Returns([Object])
    @Auth(["jwt"])
    @Post("/:id/assemble")
    public async assemble(
        @Param("id") id: string,
        body: ComposeAssembleInput,
        @AuthUser user?: JWTUser,
    ): Promise<M> {
        if (!this.blobStore || !this.aclUtils) {
            throw new ApiError(ApiErrors.INTERNAL_ERROR, 500, ApiErrorMessages.INTERNAL_ERROR);
        }
        await this.init();

        // No recipients or an empty body is a valid draft (see `ComposeAssembleInput`); only malformed input is refused.
        if (
            !body ||
            typeof body !== "object" ||
            !isRecipientList(body.to) ||
            !isRecipientList(body.cc) ||
            !isRecipientList(body.bcc) ||
            (body.html !== undefined && typeof body.html !== "string") ||
            (body.subject !== undefined && typeof body.subject !== "string")
        ) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, ApiErrorMessages.INVALID_REQUEST);
        }
        const to: Recipient[] = body.to ?? [];

        const message: M | undefined = await this.messageRepo!.findOne(id, { ignoreACL: true });
        if (!message) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }
        if (!(await this.aclUtils.hasPermission(user, message.folderUid, ACLAction.UPDATE))) {
            throw new ApiError(ApiErrors.AUTH_PERMISSION_FAILURE, 403, ApiErrorMessages.AUTH_PERMISSION_FAILURE);
        }

        const folder: F | undefined = await this.folderRepo!.findOne(message.folderUid, { ignoreACL: true });
        if (folder?.type !== FolderType.DRAFTS) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "Only a message in Drafts can be assembled.");
        }
        // Delivered mail (scanned in by ingest) can land in Drafts through a mail filter rule; rewriting it here would
        // forge its content, so only a genuine draft is assembled - the same rule activesync applies to body changes.
        if ((message as any).scanResultUid) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "A delivered message can't be edited as a draft.");
        }

        const mailbox: X | undefined = await this.mailboxRepo!.findOne(message.mailboxUid, { ignoreACL: true });
        if (!mailbox) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }

        const attachmentRecords: A[] = await this.attachmentRepo!.find(
            { messageUid: message.uid },
            { ignoreACL: true, limit: 1000 },
        );

        // Checked against each attachment's already-known `sizeBytes` - deliberately before loading any blob
        // content below, so an oversized draft is rejected without ever buffering its attachments into memory.
        const maxAttachmentBytes =
            (this.config?.get("mail:compose:max_attachment_bytes") as number | undefined) ??
            DEFAULT_MAX_COMPOSE_ATTACHMENT_BYTES;
        const totalAttachmentBytes = attachmentRecords.reduce((sum, a) => sum + (a.sizeBytes ?? 0), 0);
        if (totalAttachmentBytes > maxAttachmentBytes) {
            throw new ApiError(
                ApiErrors.PAYLOAD_TOO_LARGE,
                413,
                `This draft's attachments total ${totalAttachmentBytes} bytes, exceeding the ${maxAttachmentBytes}-byte limit.`,
            );
        }

        const attachments = await Promise.all(
            attachmentRecords.map(async (attachment) => ({
                filename: attachment.filename,
                contentType: attachment.mimeType,
                content: await this.blobStore!.get(attachment.blobKey),
                cid: attachment.contentId,
            })),
        );

        const html = sanitizeComposeHtml(rewriteInlineImageSources(body.html ?? "", attachmentRecords));

        const fromName: string | undefined = safeFromDisplayName(mailbox.displayName);
        const from = fromName ? { name: fromName, address: mailbox.primarySmtpAddress } : mailbox.primarySmtpAddress;
        const raw: Buffer = await new MailComposer({
            from,
            to: to.map(toNodemailerAddress),
            cc: body.cc?.map(toNodemailerAddress),
            bcc: body.bcc?.map(toNodemailerAddress),
            subject: body.subject ?? "",
            html,
            attachments,
        })
            .compile()
            .build();

        const recipients: Recipient[] = [
            ...to.map((r) => ({ ...r, type: RecipientType.TO })),
            ...(body.cc ?? []).map((r) => ({ ...r, type: RecipientType.CC })),
            ...(body.bcc ?? []).map((r) => ({ ...r, type: RecipientType.BCC })),
        ];

        return await this.storeBody(message, raw, user, {
            subject: body.subject ?? "",
            recipients,
            from: { address: mailbox.primarySmtpAddress, displayName: fromName, type: RecipientType.TO },
            bodyPreview: toPreview(html),
            hasAttachments: attachmentRecords.length > 0,
        });
    }

    /**
     * Stores `raw` as a new body blob and points the draft at it. Each assemble writes a new blob (the old key may be
     * read by a send in progress), so the one it replaces is deleted afterwards - only when this compose path created
     * it (`bodies/`; an EAS/MAPI send handler uses the same prefix for the same purpose) and no message row, deleted
     * ones included, still references it, and the mailbox isn't under a legal hold. When the update fails (e.g. a
     * concurrent edit's version conflict) the new blob is deleted instead and the draft keeps its old one.
     */
    private async storeBody(message: M, raw: Buffer, user: JWTUser | undefined, patch: Record<string, unknown>): Promise<M> {
        const previousKey: string | undefined = (message as any).bodyBlobKey;
        const bodyBlobKey = `${COMPOSED_BODY_PREFIX}${crypto.randomUUID()}`;
        await this.blobStore!.put(bodyBlobKey, raw, { contentType: "message/rfc822" });

        // `update()` only enforces the optimistic lock (a 409 when `send()` or another save changed the draft since it
        // was read) when `existing` is an entity instance. `findOne()` returns one today; a plain document (e.g. from a
        // backend or cache path that doesn't instantiate) would turn this into an unconditional overwrite that could
        // swap the body of a message already claimed for sending.
        const existing: M = message instanceof BaseEntity ? message : new this.messageClass(message);
        let updated: M;
        try {
            updated = await this.messageRepo!.update(
                { uid: message.uid, version: (message as any).version, ...patch, bodyBlobKey } as any,
                existing,
                { user, ignoreACL: true },
            );
        } catch (err) {
            await this.blobStore!.delete(bodyBlobKey).catch(() => undefined);
            throw err;
        }

        if (typeof previousKey === "string" && previousKey.startsWith(COMPOSED_BODY_PREFIX) && previousKey !== bodyBlobKey) {
            try {
                const references: number = await this.messageRepo!.count(
                    { bodyBlobKey: `eq(${previousKey})` },
                    { ignoreACL: true, includeDeleted: true },
                );
                // A mailbox under legal hold keeps every body it had: the superseded draft content may be discoverable.
                if (references === 0 && !(await this.hasActiveLegalHold(message.mailboxUid))) {
                    await this.blobStore!.delete(previousKey);
                }
            } catch (err: any) {
                // The draft is already updated; a leftover blob is only wasted storage.
                (this._objectFactory as any)?.logger?.warn?.(`Failed to delete replaced draft body ${previousKey}: ${err?.message ?? err}`);
            }
        }
        return updated;
    }

    /**
     * `true` when an open `Matter` names `mailboxUid` as a custodian, whatever its date range - the same check as
     * restapi's `findActiveHoldsFor()` without a reference date, which the package doesn't export. Every `Matter` is
     * read, keyset-paged on `uid` (a single unpaginated `find()` stops at the default page size and could miss a hold).
     * A cursor that doesn't advance counts as held, so a misbehaving backend never lets a held blob be deleted.
     */
    protected async hasActiveLegalHold(mailboxUid: string): Promise<boolean> {
        const limit = 500;
        let after: string | undefined;
        for (;;) {
            const query: Record<string, unknown> = { sort: { uid: "ASC" }, limit };
            if (after !== undefined) {
                query.uid = `gt(${after})`;
            }
            const batch: Matter[] = await this.matterRepo!.find(query, { ignoreACL: true, limit, skipCache: true });
            if (batch.some((matter) => !matter.closedAt && (matter.custodianMailboxUids ?? []).includes(mailboxUid))) {
                return true;
            }
            if (batch.length < limit) {
                return false;
            }
            const last: string = batch[batch.length - 1].uid;
            if (after !== undefined && !(last > after)) {
                return true;
            }
            after = last;
        }
    }

    @Summary("Assemble an already-composed (signed/encrypted) draft")
    @Description(
        "Stores client-supplied raw RFC 5322 MIME source as the draft's bodyBlobKey, completely unmodified - " +
            "does NOT sanitize, compose, or otherwise touch the bytes, since a signed message's signature " +
            "would be invalidated by any downstream reformatting. Its top-level From/Sender must be this mailbox's " +
            "own addresses, To/Cc must match the recipients, and Bcc/Resent-* headers are rejected. Does NOT send it. Call " +
            "POST /messages/:id/send afterward to relay it, same as assemble().",
    )
    @Returns([Object])
    @Auth(["jwt"])
    @Post("/:id/assemble-raw")
    public async assembleRaw(
        @Param("id") id: string,
        body: ComposeAssembleRawInput,
        @AuthUser user?: JWTUser,
    ): Promise<M> {
        if (!this.blobStore || !this.aclUtils) {
            throw new ApiError(ApiErrors.INTERNAL_ERROR, 500, ApiErrorMessages.INTERNAL_ERROR);
        }
        await this.init();

        if (!body?.to?.length || !body.rawMime) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, ApiErrorMessages.INVALID_REQUEST);
        }

        const message: M | undefined = await this.messageRepo!.findOne(id, { ignoreACL: true });
        if (!message) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }
        if (!(await this.aclUtils.hasPermission(user, message.folderUid, ACLAction.UPDATE))) {
            throw new ApiError(ApiErrors.AUTH_PERMISSION_FAILURE, 403, ApiErrorMessages.AUTH_PERMISSION_FAILURE);
        }

        const folder: F | undefined = await this.folderRepo!.findOne(message.folderUid, { ignoreACL: true });
        if (folder?.type !== FolderType.DRAFTS) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "Only a message in Drafts can be assembled.");
        }
        // Delivered mail (scanned in by ingest) can land in Drafts through a mail filter rule; rewriting it here would
        // forge its content, so only a genuine draft is assembled - the same rule activesync applies to body changes.
        if ((message as any).scanResultUid) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "A delivered message can't be edited as a draft.");
        }

        const mailbox: X | undefined = await this.mailboxRepo!.findOne(message.mailboxUid, { ignoreACL: true });
        if (!mailbox) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }

        // Signed/encrypted messages don't support file attachments yet (a client would have to embed
        // them as additional MIME parts before signing/encrypting, which crypto/smimeMessage.ts doesn't
        // build today) - reject rather than silently proceeding with a draft the user thinks includes
        // files it doesn't, if they uploaded any via the ordinary attachment-upload endpoint first.
        const attachmentCount = await this.attachmentRepo!.count({ messageUid: message.uid } as any, { ignoreACL: true });
        if (attachmentCount > 0) {
            throw new ApiError(
                ApiErrors.INVALID_REQUEST,
                400,
                "A signed or encrypted message cannot include file attachments yet - remove them before sending.",
            );
        }

        // The message is relayed as-is, so its size is capped like an assembled draft's attachments are.
        const maxMessageBytes =
            (this.config?.get("mail:compose:max_attachment_bytes") as number | undefined) ??
            DEFAULT_MAX_COMPOSE_ATTACHMENT_BYTES;
        const rawBytes: Buffer = Buffer.from(body.rawMime, "utf-8");
        if (rawBytes.length > maxMessageBytes) {
            throw new ApiError(
                ApiErrors.PAYLOAD_TOO_LARGE,
                413,
                `This message is ${rawBytes.length} bytes, exceeding the ${maxMessageBytes}-byte limit.`,
            );
        }

        // The bytes are never rewritten (that would break a signature), so the headers recipients see must already say
        // what the server would have written itself.
        assertRawMimeHeadersMatch(body.rawMime, mailbox, body);

        const recipients: Recipient[] = [
            ...body.to.map((r) => ({ ...r, type: RecipientType.TO })),
            ...(body.cc ?? []).map((r) => ({ ...r, type: RecipientType.CC })),
            ...(body.bcc ?? []).map((r) => ({ ...r, type: RecipientType.BCC })),
        ];

        return await this.storeBody(message, rawBytes, user, {
            subject: body.subject,
            recipients,
            from: { address: mailbox.primarySmtpAddress, displayName: safeFromDisplayName(mailbox.displayName), type: RecipientType.TO },
            // Never derived from the raw MIME itself - this server has no business parsing a
            // signed/encrypted body's content just to produce a list-view preview string, and for a
            // genuinely encrypted message it couldn't anyway. `ScanPipeline` (@rapidmx/restapi) is
            // still what actually detects `encrypted: true` from the stored MIME structure itself,
            // independent of this preview being empty.
            bodyPreview: "",
            hasAttachments: false,
        });
    }
}
