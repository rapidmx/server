///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
import config from "../../src/config.mongo.js";
import { Logger } from "@rapidrest/core";
import { ObjectFactory } from "@rapidrest/service-core";
import { PostfixSendmailTransport } from "@rapidmx/restapi";
import { ClamAvScanProvider, RspamdSpamScanProvider } from "@rapidmx/restapi/scan";
import { registerMailProviders } from "../../src/dev/registerMailProviders.js";
import { DevBypassAvScanProvider, DevBypassSpamScanProvider, DevScanBypass } from "../../src/dev/DevScanBypass.js";
import { DevLocalDeliveryTransport } from "../../src/dev/DevLocalDeliveryTransport.js";
import { DevLocalDeliveryTransportMongo } from "../../src/dev/DevLocalDeliveryTransportMongo.js";

function recordRegistrations(environment: string | undefined): Record<string, any> {
    const registered: Record<string, any> = {};
    registerMailProviders({ register: (clazz: any, fqn?: string) => (registered[fqn!] = clazz) }, DevLocalDeliveryTransportMongo, environment);
    return registered;
}

describe("registerMailProviders", () => {
    it("registers exactly the real, fail-closed providers for production and any other non-development NODE_ENV", () => {
        for (const environment of ["production", undefined, "", "staging", "prod", "Development"]) {
            expect(recordRegistrations(environment)).toEqual({
                SpamScanProvider: RspamdSpamScanProvider,
                AvScanProvider: ClamAvScanProvider,
                MailTransport: PostfixSendmailTransport,
            });
        }
    });

    it("registers the development wrappers for dev, development and test", () => {
        for (const environment of ["dev", "development", "test"]) {
            expect(recordRegistrations(environment)).toEqual({
                SpamScanProvider: DevBypassSpamScanProvider,
                AvScanProvider: DevBypassAvScanProvider,
                MailTransport: DevLocalDeliveryTransportMongo,
            });
        }
    });

    it("resolves the unwrapped providers from a real ObjectFactory in production", async () => {
        const objectFactory = new ObjectFactory(config, Logger());
        registerMailProviders(objectFactory, DevLocalDeliveryTransportMongo, "production");

        const spam: any = await objectFactory.newInstance("SpamScanProvider", { name: "default" });
        const av: any = await objectFactory.newInstance("AvScanProvider", { name: "default" });
        const transport: any = await objectFactory.newInstance("MailTransport", { name: "default" });

        expect(Object.getPrototypeOf(spam)).toBe(RspamdSpamScanProvider.prototype);
        expect(Object.getPrototypeOf(av)).toBe(ClamAvScanProvider.prototype);
        expect(Object.getPrototypeOf(transport)).toBe(PostfixSendmailTransport.prototype);
        expect(spam).not.toBeInstanceOf(DevScanBypass);
        expect(av).not.toBeInstanceOf(DevScanBypass);
        expect(transport).not.toBeInstanceOf(DevLocalDeliveryTransport);
    });

    it("resolves the development wrappers, each around its real implementation, from a real ObjectFactory", async () => {
        const objectFactory = new ObjectFactory(config, Logger());
        registerMailProviders(objectFactory, DevLocalDeliveryTransportMongo, "development");

        const spam: any = await objectFactory.newInstance("SpamScanProvider", { name: "default" });
        const av: any = await objectFactory.newInstance("AvScanProvider", { name: "default" });
        const transport: any = await objectFactory.newInstance("MailTransport", { name: "default" });

        expect(spam).toBeInstanceOf(DevBypassSpamScanProvider);
        expect(spam.inner).toBeInstanceOf(RspamdSpamScanProvider);
        expect(av).toBeInstanceOf(DevBypassAvScanProvider);
        expect(av.inner).toBeInstanceOf(ClamAvScanProvider);
        expect(transport).toBeInstanceOf(DevLocalDeliveryTransportMongo);
        expect(transport.inner).toBeInstanceOf(PostfixSendmailTransport);
    });
});
