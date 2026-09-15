///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import * as fs from "fs";
import { ObjectDecorators } from "@rapidrest/core";
import type { ObjectFactory } from "@rapidrest/service-core";
import { PostfixSendmailTransport, type MailTransport, type OutboundMessage, type TransportResult } from "@rapidmx/restapi";
const { Config, Inject, Logger } = ObjectDecorators;

/** The part of `BaseMailIngestRoute` this transport calls. */
interface IngestRoute {
    deliver(req: any, res: any): Promise<any>;
}

/**
 * DEV-ONLY. `PostfixSendmailTransport`, except that when its `sendmail` binary (`mail:transport:sendmail:path`) doesn't
 * exist - `yarn dev` with no Postfix/msmtp installed, which the real transport can only report as "relayed to nobody" -
 * the message is delivered to this server's own mailboxes the way Postfix would hand it back: through the MTA ingest
 * route's `deliver()` (`/internal/mta/deliver`), which queues it for `ScanQueueJob`. Recipients that aren't a local
 * mailbox or distribution list are reported rejected, with a warning, since there is no MTA to relay them.
 *
 * Registered only by `registerMailProviders()` for `dev`/`development`/`test`. When the binary exists the real transport
 * is used unchanged. Subclassed per datastore for the ingest route class (`DevLocalDeliveryTransportMongo`/`SQL`).
 */
export abstract class DevLocalDeliveryTransport implements MailTransport {
    public readonly name: string = "postfix-sendmail";

    /** The datastore's `MailIngestRoute` class (`MailIngestRouteMongo`/`MailIngestRouteSQL`). */
    protected abstract readonly ingestRouteClass: any;

    @Inject(PostfixSendmailTransport)
    private inner?: MailTransport;

    // The same key and default `PostfixSendmailTransport` runs.
    @Config("mail:transport:sendmail:path", "/usr/sbin/sendmail")
    private sendmailPath: string = "/usr/sbin/sendmail";

    @Config("mail:transport:ingest:secret", "")
    private ingestSecret: string = "";

    @Logger
    private logger: any;

    // Automatically injected by ObjectFactory on instantiation.
    private _objectFactory?: ObjectFactory;

    private warned: boolean = false;

    public async send(message: OutboundMessage): Promise<TransportResult> {
        if (fs.existsSync(this.sendmailPath)) {
            if (!this.inner) {
                throw new Error("The development local delivery transport has no PostfixSendmailTransport to wrap.");
            }
            return await this.inner.send(message);
        }

        if (!this.warned) {
            this.warned = true;
            this.logger?.warn(
                `[dev] No sendmail binary at ${this.sendmailPath} (mail:transport:sendmail:path), so outbound mail is not relayed: ` +
                    "messages to this server's own mailboxes are delivered locally, and other recipients are rejected. To relay " +
                    "mail, run the postfix-bridge stack (github.com/rapidmx/postfix-bridge) and point " +
                    "mail:transport:sendmail:path at a sendmail that reaches it. This only happens with NODE_ENV dev/development/test.",
            );
        }

        // Lazily, not injected: the ingest route itself injects "MailTransport" (this class).
        const route: IngestRoute = await this._objectFactory!.newInstance<IngestRoute>(this.ingestRouteClass, { name: "default" });
        const response = { statusCode: 0, body: undefined as any };
        const res = {
            status(code: number) {
                response.statusCode = code;
                return res;
            },
            json(body: any) {
                response.body = body;
                return res;
            },
        };
        await route.deliver(
            {
                headers: {
                    authorization: `Bearer ${this.ingestSecret}`,
                    "x-envelope-from": message.envelopeFrom,
                    "x-envelope-to": message.envelopeTo.join(","),
                },
                rawBody: message.raw,
            },
            res,
        );

        const results: { rcpt: string; queued: boolean }[] = response.body?.results ?? [];
        const accepted: string[] = results.filter((r) => r.queued).map((r) => r.rcpt);
        const rejected: string[] = results.filter((r) => !r.queued).map((r) => r.rcpt);
        if (rejected.length > 0) {
            this.logger?.warn(
                `[dev] Not delivered (no local mailbox, and no MTA to relay to without a sendmail binary): ${rejected.join(", ")}`,
            );
        }
        return { accepted, rejected };
    }
}
