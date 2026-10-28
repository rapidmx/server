///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2020-2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
vi.mock("redis", async () => {
    const { createFakeRedisModule } = await import("./helpers/FakeRedis.js");
    return createFakeRedisModule();
});

const corsOrigins = ["http://localhost:3000", "http://localhost:3001", "http://localhost:3002"];
process.env[`cors__origins`] = JSON.stringify(corsOrigins);

import { LocalIntegrationsChannel } from "../src/integrations/IntegrationsChannel.js";
import config from "../src/config.mongo.js";
import { MongoMemoryServer } from "mongodb-memory-server";
import { Logger, sleep } from "@rapidrest/core";
import { ObjectFactory, RateLimiter, RepoUtils, Server } from "@rapidrest/service-core";
import {
    FsDkimKeyProvider,
    LocalFsBlobStore,
    LocalX509CertificateAuthority,
    ManualSigningCertificateEnrollment,
    NodeDnsResolver,
    PostfixSendmailTransport,
    CONFIG_KEY_STATE_UID,
    configKeyCopyId,
    generateConfigKeyring,
    sharedLocalConfigKeyChannel,
} from "@rapidmx/restapi";
import { ConfigKeyStateMongo, PluginSecretEncryptorMongo } from "@rapidmx/restapi/mongo";
import { MongoTextSearchProvider } from "@rapidmx/restapi/search";
import { ClamAvScanProvider, RspamdSpamScanProvider } from "@rapidmx/restapi/scan";
import { startConfigEncryption } from "../src/lib/configEncryption.js";
import { TieredRateLimiter } from "../src/lib/TieredRateLimiter.js";
import { TrackedConfigCipherMongo } from "../src/secrets/TrackedConfigCipherMongo.js";
import { OpenBaoClientPkiCertificateAuthority } from "../src/openbao/OpenBaoClientPkiCertificateAuthority.js";
import { setDraining } from "../src/plugins/readiness.js";
import { freePort, localRequest } from "./helpers/serverTestUtils.js";

const DNS_CONTROLLER_SUBJECT = "system:serviceaccount:mail:rel-dns-controller";

class StubDnsControllerTokenVerifier {
    public async verify(token: string): Promise<{ subject: string }> {
        if (token === "controller" || token === "someone-else") {
            return { subject: token === "controller" ? DNS_CONTROLLER_SUBJECT : "system:serviceaccount:mail:rel" };
        }
        throw new Error("the token's signature does not verify");
    }
}

// No fixed port: a free one is picked when it starts, and the datastore URLs below point at it.
const mongod: MongoMemoryServer = new MongoMemoryServer({
    instance: {
        dbName: "mongomemory-rrst-test",
    },
});

describe("Server Tests", () => {
    const logger = new Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    // Mirrors the DI provider registration registerCoreProviders() (src/lib/registerCoreProviders.ts) applies for
    // src/worker.mongo.ts — this test builds its own Server rather than importing that entry point (it runs `void
    // start(...)` unconditionally at module load with no "only if this is the main module" guard - see
    // selectConfigDrivenBackend()'s own doc comment), so it must register the same @rapidmx/restapi string-token
    // dependencies itself or any route touching them (BlobStore/SearchProvider/SpamScanProvider/AvScanProvider/
    // MailTransport/DnsResolver/DkimKeyProvider) fails to instantiate.
    // Always LocalFsBlobStore here, even though worker.mongo.ts's real registration is config-driven
    // (mail:blob:backend) - a test run has no business making live network S3 calls.
    objectFactory.register(LocalFsBlobStore, "BlobStore");
    objectFactory.register(MongoTextSearchProvider, "SearchProvider");
    objectFactory.register(RspamdSpamScanProvider, "SpamScanProvider");
    objectFactory.register(ClamAvScanProvider, "AvScanProvider");
    objectFactory.register(PostfixSendmailTransport, "MailTransport");
    // Always NodeDnsResolver here, even though worker.mongo.ts's real registration is config-driven
    // (mail:dns:resolver) - a test run has no business making live network DoH queries, and nothing this
    // suite exercises depends on DNSSEC validation actually happening.
    objectFactory.register(NodeDnsResolver, "DnsResolver");
    objectFactory.register(FsDkimKeyProvider, "DkimKeyProvider");
    // Mirrors worker.mongo.ts's config-driven CA backend selection (mail:pki:backend) - not currently
    // exercised by any mounted route/test, but kept in sync so registering a KeyVault-style route later
    // doesn't hit a "no class found with name: EncryptionCertificateAuthority" surprise here.
    const caBackend: string = config.get("mail:pki:backend") || "local";
    objectFactory.register(
        caBackend === "openbao" ? OpenBaoClientPkiCertificateAuthority : LocalX509CertificateAuthority,
        "EncryptionCertificateAuthority"
    );
    // Always ManualSigningCertificateEnrollment here, even though worker.mongo.ts's real registration is
    // config-driven (mail:pki:signing_enrollment:backend) - a test run has no business making live ACME
    // network calls against a real certificate authority.
    objectFactory.register(ManualSigningCertificateEnrollment, "SigningCertificateEnrollment");
    objectFactory.register(TieredRateLimiter, "RateLimiter");
    // Reads the active key from the datastore; the keyring is the one beforeAll() configures.
    objectFactory.register(TrackedConfigCipherMongo, "ConfigCipher");
    // Where a saved change to the Integrations is announced (a test server is one copy, so the process's own listeners are all there are).
    objectFactory.register(LocalIntegrationsChannel, "IntegrationsChannel");
    // The verifier the server registers checks the controller's projected token against the cluster's keys, which a test run doesn't have: this one knows two tokens.
    objectFactory.register(StubDnsControllerTokenVerifier, "DnsControllerTokenVerifier");
    let server: Server;
    let port: number;

    beforeAll(async () => {
        // The keyring the configuration cipher reads when the server starts.
        config.set("config_encryption:keyring", JSON.stringify(generateConfigKeyring()));
        // The one ServiceAccount whose token /internal/dns accepts (the chart sets it).
        config.set("mail:dns:controller:subject", DNS_CONTROLLER_SUBJECT);
        await mongod.start();
        for (const name of ["acl", "mongo"]) {
            config.set(`datastores:${name}:url`, mongod.getUri());
        }
        // A free port on 127.0.0.1 rather than the default 3000, which a running `yarn dev` server may already hold.
        port = await freePort();
        config.set("port", port);
        config.set("listen_host", "127.0.0.1");
        server = new Server({ config, basePath: "./src/mongo", logger, objectFactory });
    });

    afterAll(async () => {
        await mongod.stop();
    });

    beforeEach(async () => {
        expect(server).toBeInstanceOf(Server);
        await server.start();
        // Wait a bit longer each time. This allows objects to finish initialization before we proceed.
        await sleep(1000);
    });

    afterEach(async () => {
        await server.stop();
    });

    // First, while the instances the server built on this start are the ones in the ObjectFactory: the harness restarts the server for every test without destroying the
    // factory, so after the first start they still hold the datastore connection of the one before.
    it("Starts the configuration encryption: the keyring heartbeat reports this copy, and the plugin secret encryption completes against the datastore.", async () => {
        const runtime = await startConfigEncryption(objectFactory, PluginSecretEncryptorMongo, logger);
        try {
            const states = await objectFactory.newInstance<RepoUtils<any>>(RepoUtils, { name: "config-key-state-probe", args: [ConfigKeyStateMongo] });
            let state: any;
            for (let attempt = 0; attempt < 50 && !state?.pluginSecrets?.encryptedAt; attempt++) {
                await sleep(100);
                state = await states.findOne(CONFIG_KEY_STATE_UID, { ignoreACL: true, skipCache: true });
            }
            // No plugin holds a secret in plaintext, so the first run completes at once (a Kubernetes server would wait for its rollout first).
            expect(state?.pluginSecrets?.encryptedAt).toBeDefined();
            const beats = await sharedLocalConfigKeyChannel().heartbeats();
            const mine = beats.find((beat) => beat.copy === configKeyCopyId());
            expect(mine?.kids).toHaveLength(1);
            expect(mine?.encrypting).toBe(mine?.kids[0]);
        } finally {
            await runtime.stop();
        }
    });

    it("Can start server.", async () => {
        expect(server.isRunning()).toBe(true);
        // Cors Check
        let result = await localRequest(port, "OPTIONS", "/", { Origin: corsOrigins[0] });
        expect(result.headers["access-control-allow-origin"]).toEqual(corsOrigins[0]);
        result = await localRequest(port, "OPTIONS", "/", { Origin: "http://localhost:3005" });
        expect(result.headers["access-control-allow-origin"]).not.toBeDefined();
    });

    it("Reports not ready while draining for a plugin restart, and rate limits with TieredRateLimiter.", async () => {
        expect((await localRequest(port, "GET", "/api/status")).status).toBe(200);
        setDraining(true);
        try {
            expect((await localRequest(port, "GET", "/api/status")).status).toBe(503);
        } finally {
            setDraining(false);
        }
        expect((await localRequest(port, "GET", "/api/status")).status).toBe(200);
        expect(await objectFactory.newInstance(RateLimiter, { name: "default" })).toBeInstanceOf(TieredRateLimiter);
    });

    it("Mounts the configuration key console, the DNS provider configs and the Integrations settings, which need a signed-in administrator.", async () => {
        for (const path of ["/api/system/config-keys", "/api/system/dns-providers", "/api/system/integrations"]) {
            const result = await localRequest(port, "GET", path);
            expect([401, 403], path).toContain(result.status);
        }
    });

    it("Mounts the DNS controller's API at /internal/dns, which takes the controller's token only and never a proxied request.", async () => {
        const handshake = JSON.stringify({ kind: "Handshake", controllerVersion: "0.1.0", apiVersions: ["dns.rapidmx.io/v1"] });
        const call = (token?: string, extra: Record<string, string> = {}) =>
            localRequest(port, "POST", "/internal/dns/handshake", { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra }, handshake);
        expect((await call()).status).toBe(403);
        expect((await call("forged")).status).toBe(403);
        // A valid token of another ServiceAccount than mail:dns:controller:subject.
        expect((await call("someone-else")).status).toBe(403);
        expect((await call("controller", { "X-Forwarded-For": "203.0.113.9" })).status).toBe(403);
        const accepted = await call("controller");
        expect(accepted.status).toBe(200);
        expect(JSON.parse(accepted.body)).toMatchObject({ kind: "HandshakeResult", compatible: true, selected: "dns.rapidmx.io/v1" });
        // The other handlers, the credentials one included, answer the same refusal without a token.
        for (const path of ["/internal/dns/v1/desired-state", "/internal/dns/v1/providers/dns-cloudflare-1a2b3c4d/credentials"]) {
            expect((await localRequest(port, "GET", path)).status, path).toBe(403);
        }
    });

    it("Can stop server.", async () => {
        expect(server.isRunning()).toBe(true);
        await server.stop();
        expect(server.isRunning()).toBe(false);
    });

    it("Can restart server.", async () => {
        expect(server.isRunning()).toBe(true);
        await server.restart();
        expect(server.isRunning()).toBe(true);
    });
});
