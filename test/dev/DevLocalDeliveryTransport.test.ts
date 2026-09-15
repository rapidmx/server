///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
import * as os from "os";
import * as path from "path";
import { MailIngestRouteMongo } from "@rapidmx/restapi/mongo";
import { MailIngestRouteSQL } from "@rapidmx/restapi/sql";
import { DevLocalDeliveryTransportMongo } from "../../src/dev/DevLocalDeliveryTransportMongo.js";
import { DevLocalDeliveryTransportSQL } from "../../src/dev/DevLocalDeliveryTransportSQL.js";

const MESSAGE = { raw: Buffer.from("Subject: hi\r\n\r\nhello\r\n"), envelopeFrom: "me@example.com", envelopeTo: ["you@example.com", "them@elsewhere.test"] };

function transport(sendmailPath: string, inner: any, route?: any) {
    const instance = new DevLocalDeliveryTransportMongo();
    const logger = { warn: vi.fn() };
    const objectFactory = { newInstance: vi.fn(async () => route) };
    Object.assign(instance as any, { inner, sendmailPath, ingestSecret: "secret", logger, _objectFactory: objectFactory });
    return { instance, logger, objectFactory };
}

describe("DevLocalDeliveryTransport", () => {
    it("uses the real transport unchanged when the sendmail binary exists", async () => {
        const result = { accepted: ["you@example.com"], rejected: [], messageId: "<x@example.com>" };
        const inner = { name: "postfix-sendmail", send: vi.fn().mockResolvedValue(result) };
        const { instance, logger, objectFactory } = transport(process.execPath, inner);

        expect(await instance.send(MESSAGE)).toBe(result);
        expect(inner.send).toHaveBeenCalledWith(MESSAGE);
        expect(objectFactory.newInstance).not.toHaveBeenCalled();
        expect(logger.warn).not.toHaveBeenCalled();
        expect(instance.name).toBe("postfix-sendmail");
    });

    it("throws when the sendmail binary exists but there is no real transport to use", async () => {
        const { instance } = transport(process.execPath, undefined);
        await expect(instance.send(MESSAGE)).rejects.toThrow("PostfixSendmailTransport");
    });

    it("delivers through the ingest route without a sendmail binary, rejecting recipients it couldn't queue", async () => {
        const route = {
            deliver: vi.fn(async (_req: any, res: any) =>
                res.status(202).json({
                    results: [
                        { rcpt: "you@example.com", queued: true },
                        { rcpt: "them@elsewhere.test", queued: false },
                    ],
                }),
            ),
        };
        const inner = { name: "postfix-sendmail", send: vi.fn() };
        const { instance, logger, objectFactory } = transport(path.join(os.tmpdir(), "rapidmx-no-such-sendmail"), inner, route);

        expect(await instance.send(MESSAGE)).toEqual({ accepted: ["you@example.com"], rejected: ["them@elsewhere.test"] });
        expect(inner.send).not.toHaveBeenCalled();
        expect(objectFactory.newInstance).toHaveBeenCalledWith(MailIngestRouteMongo, { name: "default" });
        const [req] = route.deliver.mock.calls[0];
        expect(req.headers).toEqual({
            authorization: "Bearer secret",
            "x-envelope-from": "me@example.com",
            "x-envelope-to": "you@example.com,them@elsewhere.test",
        });
        expect(req.rawBody).toBe(MESSAGE.raw);
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("[dev] No sendmail binary"));
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("them@elsewhere.test"));

        // The no-sendmail warning is logged once, not per message.
        logger.warn.mockClear();
        route.deliver.mockImplementationOnce(async (_req: any, res: any) => res.status(202).json({ results: [{ rcpt: "you@example.com", queued: true }] }));
        expect(await instance.send({ ...MESSAGE, envelopeTo: ["you@example.com"] })).toEqual({ accepted: ["you@example.com"], rejected: [] });
        expect(logger.warn).not.toHaveBeenCalled();
    });

    it("reports nothing accepted when the ingest route returns no results", async () => {
        const route = { deliver: vi.fn(async (_req: any, res: any) => res.status(400)) };
        const { instance } = transport(path.join(os.tmpdir(), "rapidmx-no-such-sendmail"), undefined, route);

        expect(await instance.send(MESSAGE)).toEqual({ accepted: [], rejected: [] });
    });

    it("delivers through each datastore's own ingest route", () => {
        expect((new DevLocalDeliveryTransportMongo() as any).ingestRouteClass).toBe(MailIngestRouteMongo);
        expect((new DevLocalDeliveryTransportSQL() as any).ingestRouteClass).toBe(MailIngestRouteSQL);
    });
});
