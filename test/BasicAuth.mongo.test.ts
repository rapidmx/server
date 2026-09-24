///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
// The Basic (app password) sign-in for Outlook and ActiveSync, end to end through a real server: a request for a configured path
// is authenticated against a fake auth-server, and a 401 carries the challenge that makes a client send credentials.
vi.mock("redis", async () => {
    const { createFakeRedisModule } = await import("./helpers/FakeRedis.js");
    return createFakeRedisModule();
});

import * as http from "http";
import config from "../src/config.mongo.js";
import { MongoMemoryServer } from "mongodb-memory-server";
import { JWTUtils, Logger, sleep } from "@rapidrest/core";
import { ObjectFactory, Server } from "@rapidrest/service-core";
import { MailboxMongo, PluginMongo } from "@rapidmx/restapi/mongo";
import { MongoTextSearchProvider } from "@rapidmx/restapi/search";
import { DevLocalDeliveryTransportMongo } from "../src/dev/DevLocalDeliveryTransportMongo.js";
import { enableBasicAuthIfApplicable } from "../src/lib/enableBasicAuth.js";
import { registerCoreProviders } from "../src/lib/registerCoreProviders.js";
import { freePort, localRequest } from "./helpers/serverTestUtils.js";

const USER = { uid: "5b1f7d8e-9d4a-4c55-9a53-0c6f5f1f2a10", roles: [] as string[], scopes: [] as string[] };
const basic = (name: string, password: string) => `Basic ${Buffer.from(`${name}:${password}`).toString("base64")}`;

describe("Basic sign-in through a real server", () => {
    const logger = new Logger("warn");
    const mongod: MongoMemoryServer = new MongoMemoryServer({ instance: { dbName: "mongomemory-basic-auth-test" } });
    let server: Server;
    let authServer: http.Server;
    let port: number;
    /** What the fake auth-server was asked, decoded. */
    const logins: string[] = [];

    beforeAll(async () => {
        await mongod.start();
        for (const name of ["acl", "mongo"]) {
            config.set(`datastores:${name}:url`, mongod.getUri());
        }

        // auth-server's `GET /api/auth/password`: one user with one app password.
        const authPort: number = await freePort();
        authServer = http.createServer((req, res) => {
            const decoded: string = Buffer.from(String(req.headers.authorization ?? "").slice(6), "base64").toString("utf-8");
            logins.push(decoded);
            if (req.url === "/api/auth/password" && decoded === "jp:app-password") {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ token: JWTUtils.createTokenSync(config.get("auth"), USER) }));
            } else {
                res.writeHead(401, { "content-type": "application/json" });
                res.end("{}");
            }
        });
        await new Promise<void>((resolve) => authServer.listen(authPort, "127.0.0.1", resolve));
        config.set("mail:auth_server_url", `http://127.0.0.1:${authPort}`);
        // A route this server already has that needs a signed-in user, standing in for /mapi (whose plugin isn't loaded here): the paths are configuration.
        config.set("mail:basic_auth:paths", ["/api/mail/mailboxes/domains"]);

        port = await freePort();
        config.set("port", port);
        config.set("listen_host", "127.0.0.1");
        const objectFactory = new ObjectFactory(config, logger);
        registerCoreProviders(objectFactory, config, { searchProvider: MongoTextSearchProvider, devDeliveryTransport: DevLocalDeliveryTransportMongo, environment: "development" });
        // As the worker does, before the server exists.
        await enableBasicAuthIfApplicable(objectFactory, config, logger, MailboxMongo);
        server = new Server({ config, basePath: "./src/mongo", logger, objectFactory });
        await server.start();
        await sleep(1000);
    }, 120_000);

    afterAll(async () => {
        await server?.stop();
        await new Promise<void>((resolve) => authServer.close(() => resolve()));
        await mongod.stop();
    });

    it("answers a request with no credentials for a configured path with a 401 that asks for Basic ones", async () => {
        const result = await localRequest(port, "GET", "/api/mail/mailboxes/domains");
        expect(result.status).toBe(401);
        expect(result.headers["www-authenticate"]).toBe('Basic realm="RapidMX", charset="UTF-8"');
    });

    it("signs in a username and app password checked by auth-server, and serves the request as that user", async () => {
        logins.length = 0;
        const result = await localRequest(port, "GET", "/api/mail/mailboxes/domains", { Authorization: basic("jp", "app-password") });
        expect(result.status).toBe(200);
        expect(Array.isArray(JSON.parse(result.body))).toBe(true);
        expect(logins).toEqual(["jp:app-password"]);

        // The next request with the same credentials doesn't ask auth-server again.
        expect((await localRequest(port, "GET", "/api/mail/mailboxes/domains", { Authorization: basic("jp", "app-password") })).status).toBe(200);
        expect(logins).toHaveLength(1);
    });

    it("refuses credentials auth-server refuses, with the challenge again", async () => {
        const result = await localRequest(port, "GET", "/api/mail/mailboxes/domains", { Authorization: basic("jp", "wrong") });
        expect(result.status).toBe(401);
        expect(result.headers["www-authenticate"]).toContain("Basic");
    });

    it("still takes a JWT, exactly as before", async () => {
        logins.length = 0;
        const token: string = JWTUtils.createTokenSync(config.get("auth"), USER);
        expect((await localRequest(port, "GET", "/api/mail/mailboxes/domains", { Authorization: `Bearer ${token}` })).status).toBe(200);
        expect(logins).toHaveLength(0);
    });

    it("accepts Basic nowhere else: another route does not sign the user in, with no challenge and auth-server is never asked", async () => {
        logins.length = 0;
        const result = await localRequest(port, "GET", "/api/system/plugins/status", { Authorization: basic("jp", "app-password") });
        // Not signed in (a route that needs a trusted role says 403 to an unauthenticated caller), and nothing asks for Basic credentials.
        expect([401, 403]).toContain(result.status);
        expect(result.headers["www-authenticate"]).toBeUndefined();
        expect(logins).toHaveLength(0);
    });
});
