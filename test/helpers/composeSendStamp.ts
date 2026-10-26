///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
// The search stamp a send-assemble leaves on a draft, against a real datastore (shared by the Mongo and SQL suites): the readable
// copy that waits to be relayed must never be one restapi's SearchIndexJob selects in a zero-access mailbox, or the job would index
// its plaintext.
import crypto from "crypto";
import { RepoUtils, type ObjectFactory } from "@rapidrest/service-core";

export interface ComposeSendStampContext {
    objectFactory: ObjectFactory;
    routeClass: any;
    messageClass: any;
    mailboxClass: any;
    folderClass: any;
}

/** What `SearchIndexJob.run()` selects (restapi): not stamped, with retries left. */
const SEARCH_INDEX_PENDING = (maxAttempts: number) => ({
    searchIndexedAt: null,
    $or: [{ searchIndexAttempts: "null" }, { searchIndexAttempts: `lt(${maxAttempts})`, searchIndexNextAttemptAt: `lte(${new Date().toISOString()})` }],
});

export function defineComposeSendStampTests(context: () => ComposeSendStampContext): void {
    const user = { uid: "compose-user" } as any;

    async function repo(modelClass: any): Promise<RepoUtils<any>> {
        return context().objectFactory.newInstance(RepoUtils, { name: modelClass.name, args: [modelClass] });
    }

    /** A mailbox with a draft in its Drafts folder, and the compose route with its access check passed (ACL records aren't the subject here). */
    async function draft(fields: Record<string, unknown>) {
        const { objectFactory, routeClass, messageClass, mailboxClass, folderClass } = context();
        const id: string = crypto.randomUUID();
        const address = `${id.slice(0, 8)}@example.com`;
        const mailbox = await (await repo(mailboxClass)).create(
            { uid: `mb-${id}`, primarySmtpAddress: address, displayName: "Alice", ownerUserUid: user.uid } as any,
            { ignoreACL: true },
        );
        const folder = await (await repo(folderClass)).create(
            { uid: `f-${id}`, mailboxUid: mailbox.uid, name: "Drafts", type: "drafts" } as any,
            { ignoreACL: true },
        );
        const messages: RepoUtils<any> = await repo(messageClass);
        const message = await messages.create(
            { uid: `m-${id}`, mailboxUid: mailbox.uid, folderUid: folder.uid, subject: "[...]", bodyBlobKey: `bodies/${id}`, ...fields } as any,
            { ignoreACL: true },
        );
        const route: any = await objectFactory.newInstance(routeClass, { name: `compose-send-stamp-${id}` });
        route.aclUtils = { hasPermission: async () => true };
        const rawMime: string = [
            `From: "Alice" <${address}>`,
            "To: bob@example.com",
            "Subject: [...]",
            "MIME-Version: 1.0",
            "Content-Type: text/plain",
            "",
            "The readable body that waits to be relayed.",
        ].join("\r\n");
        const send = () => route.assembleRaw(message.uid, { to: [{ address: "bob@example.com" }], subject: "[...]", rawMime, intent: "send" }, user);
        return { route, messages, message, mailbox, send };
    }

    async function selectedForIndexing(messages: RepoUtils<any>, uid: string): Promise<boolean> {
        const pending: any[] = await messages.find({ ...SEARCH_INDEX_PENDING(5), limit: 1000 } as any, { ignoreACL: true, limit: 1000 });
        return pending.some((message) => message.uid === uid);
    }

    it("stamps a sealed draft whose last save cleared its search stamp when it is assembled readable for sending, so SearchIndexJob never selects it", async () => {
        // The last autosave sealed it, clearing the stamp and its retries, and the send follows before SearchIndexJob runs.
        const { messages, message, send } = await draft({
            bodyBlobKey: `za/sealed/drafts/${crypto.randomUUID()}`,
            zeroAccess: { keyFingerprint: "fp", sealedSummary: "s" },
            searchIndexedAt: null,
        });
        expect(await selectedForIndexing(messages, message.uid)).toBe(true);

        await send();

        const stored: any = await messages.findOne(message.uid, { ignoreACL: true });
        expect(stored.zeroAccess ?? null).toBeNull();
        expect(stored.bodyBlobKey).toMatch(/^bodies\//);
        expect(stored.searchIndexedAt).toBeInstanceOf(Date);
        expect(await selectedForIndexing(messages, message.uid)).toBe(false);
    });

    it("stamps a never-sealed draft sent from a mailbox where zero-access is active", async () => {
        const { route, messages, message, mailbox, send } = await draft({ searchIndexedAt: null });
        // Zero-access as the resolver reports it (an active key needs the mailbox's real key material, which isn't the subject here).
        // The writer is shared by every route the factory builds, so the stub is undone before the next case.
        const target = vi.spyOn(route.zeroAccessWriter, "target").mockResolvedValue({ key: {} });
        try {
            await send();
            expect(target).toHaveBeenCalledWith(expect.objectContaining({ uid: mailbox.uid }));
        } finally {
            target.mockRestore();
        }

        expect(await selectedForIndexing(messages, message.uid)).toBe(false);
    });

    it("leaves a draft sent from a mailbox without zero-access for SearchIndexJob to index as before", async () => {
        // The mailbox has no zero-access key: the real resolver answers that zero-access isn't active.
        const { messages, message, send } = await draft({ searchIndexedAt: null });

        await send();

        const stored: any = await messages.findOne(message.uid, { ignoreACL: true });
        expect(stored.searchIndexedAt ?? null).toBeNull();
        expect(await selectedForIndexing(messages, message.uid)).toBe(true);
    });
}
