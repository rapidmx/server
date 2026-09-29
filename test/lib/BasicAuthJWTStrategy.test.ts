///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import config from "../../src/config.mongo.js";
import { ApiError, JWTUtils, Logger } from "@rapidrest/core";
import { JWTStrategy, ObjectFactory, type AuthStrategy } from "@rapidrest/service-core";
import {
    BasicAuthJWTStrategy,
    DEFAULT_BASIC_AUTH_PATHS,
    parseBasicCredentials,
    pathIsUnder,
} from "../../src/lib/BasicAuthJWTStrategy.js";
import { enableBasicAuthIfApplicable } from "../../src/lib/enableBasicAuth.js";

const AUTH_SERVER = "https://auth.example.com";
const USER = { uid: "5b1f7d8e-9d4a-4c55-9a53-0c6f5f1f2a10", roles: [] as string[], scopes: [] as string[] };

const basic = (name: string, password: string) => `Basic ${Buffer.from(`${name}:${password}`).toString("base64")}`;
const tokenFor = (user = USER, secret?: string): string =>
    JWTUtils.createTokenSync(secret ? { ...config.get("auth"), secret } : config.get("auth"), user);

function request(path: string, headers: Record<string, string> = {}, remote = "203.0.113.9"): any {
    return { path, headers, cookies: {}, query: {}, signedCookies: {}, socket: { remoteAddress: remote } };
}

function response(): { res: any; headers: Record<string, string> } {
    const headers: Record<string, string> = {};
    return {
        headers,
        res: {
            setHeader: (key: string, value: string) => {
                headers[key] = value;
            },
        },
    };
}

/** An auth-server answering `GET /api/auth/password`: `answer` maps the decoded credentials to an HTTP status and token. */
function authServer(answer: (name: string, password: string) => { status: number; token?: string } | Error) {
    return vi.fn(async (_url: any, init?: any) => {
        const decoded = Buffer.from(String(init.headers.Authorization).slice(6), "base64").toString("utf-8");
        const separator = decoded.indexOf(":");
        const result = answer(decoded.slice(0, separator), decoded.slice(separator + 1));
        if (result instanceof Error) {
            throw result;
        }
        return new Response(result.token ? JSON.stringify({ token: result.token }) : "{}", {
            status: result.status,
            headers: { "content-type": "application/json" },
        });
    });
}

describe("BasicAuthJWTStrategy", () => {
    const objectFactory = new ObjectFactory(config, Logger());
    let jwt: AuthStrategy;

    beforeAll(async () => {
        objectFactory.register(JWTStrategy, "auth.JWTStrategy");
        jwt = await objectFactory.newInstance<AuthStrategy>("auth.JWTStrategy");
        config.set("mail:auth_server_url", AUTH_SERVER);
    });

    afterEach(() => {
        vi.useRealTimers();
        for (const key of ["enabled", "cache_ttl_ms", "failure_limit", "paths"]) {
            config.set(`mail:basic_auth:${key}`, { enabled: true, cache_ttl_ms: 300_000, failure_limit: 10, paths: [...DEFAULT_BASIC_AUTH_PATHS] }[key]);
        }
    });

    async function strategy(fetcher: any, mailboxes: any[] = []): Promise<BasicAuthJWTStrategy> {
        const factory: any = {
            newInstance: vi.fn(async () => ({ find: vi.fn(async () => mailboxes) })),
        };
        return objectFactory.newInstance<BasicAuthJWTStrategy>(BasicAuthJWTStrategy, { args: [jwt, factory, class Mailbox {}, fetcher] });
    }

    describe("parseBasicCredentials()", () => {
        it("reads name and password, which may itself contain a colon", () => {
            expect(parseBasicCredentials(basic("jp@example.com", "a:b:c"))).toEqual({ name: "jp@example.com", password: "a:b:c" });
            expect(parseBasicCredentials([`Bearer x`, basic("jp", "pw")])).toEqual({ name: "jp", password: "pw" });
        });

        it("refuses anything that isn't Basic credentials", () => {
            for (const header of [undefined, "", "Bearer abc", "Basic", "Basic !!!", `Basic ${Buffer.from("nocolon").toString("base64")}`, `Basic ${Buffer.from(":pw").toString("base64")}`]) {
                expect(parseBasicCredentials(header)).toBeUndefined();
            }
        });
    });

    describe("pathIsUnder()", () => {
        it("matches the prefix and what is below it, in any case, but not a longer name", () => {
            expect(pathIsUnder("/mapi/emsmdb", "/mapi")).toBe(true);
            expect(pathIsUnder("/MAPI", "/mapi/")).toBe(true);
            expect(pathIsUnder("/microsoft-server-activesync", "/Microsoft-Server-ActiveSync")).toBe(true);
            expect(pathIsUnder("/mapiary", "/mapi")).toBe(false);
            expect(pathIsUnder("/api/mail/mailboxes", "/mapi")).toBe(false);
        });
    });

    describe("authenticate()", () => {
        it("leaves a JWT alone: it is verified by the real strategy and auth-server is never asked", async () => {
            const fetcher = authServer(() => ({ status: 200, token: tokenFor() }));
            const result = await (await strategy(fetcher)).authenticate(request("/mapi/emsmdb", { authorization: `Bearer ${tokenFor()}` }));
            expect(result?.user?.uid).toBe(USER.uid);
            expect(result?.method).toBe("jwt");
            expect(fetcher).not.toHaveBeenCalled();
        });

        it("signs a user in with a username and app password on a MAPI path, asking auth-server as the client", async () => {
            const fetcher = authServer((name, password) => (name === "jp" && password === "app-pass" ? { status: 200, token: tokenFor() } : { status: 401 }));
            const { res, headers } = response();
            const result = await (await strategy(fetcher)).authenticate(request("/mapi/emsmdb", { authorization: basic("jp", "app-pass") }), res);

            expect(result?.user?.uid).toBe(USER.uid);
            expect(fetcher).toHaveBeenCalledExactlyOnceWith(`${AUTH_SERVER}/api/auth/password`, expect.objectContaining({ method: "GET" }));
            expect(fetcher.mock.calls[0][1].headers).toMatchObject({ Authorization: basic("jp", "app-pass"), "X-Forwarded-For": "203.0.113.9" });
            expect(headers["WWW-Authenticate"]).toBeUndefined();
        });

        it("does the same for ActiveSync", async () => {
            const fetcher = authServer(() => ({ status: 200, token: tokenFor() }));
            const result = await (await strategy(fetcher)).authenticate(request("/Microsoft-Server-ActiveSync", { authorization: basic("jp", "pw") }));
            expect(result?.user?.uid).toBe(USER.uid);
        });

        it("remembers a successful sign-in, so a client that sends its credentials every time costs one login", async () => {
            const fetcher = authServer(() => ({ status: 200, token: tokenFor() }));
            const basicStrategy = await strategy(fetcher);
            for (let i = 0; i < 4; i++) {
                expect((await basicStrategy.authenticate(request("/mapi/nspi", { authorization: basic("jp", "pw") })))?.user?.uid).toBe(USER.uid);
            }
            expect(fetcher).toHaveBeenCalledTimes(1);
            // Different credentials are a different login.
            await basicStrategy.authenticate(request("/mapi/nspi", { authorization: basic("jp", "other") }));
            expect(fetcher).toHaveBeenCalledTimes(2);
        });

        it("asks again once the remembered sign-in has expired, and never remembers with a zero lifetime", async () => {
            vi.useFakeTimers();
            const fetcher = authServer(() => ({ status: 200, token: tokenFor() }));
            const basicStrategy = await strategy(fetcher);
            await basicStrategy.authenticate(request("/mapi/emsmdb", { authorization: basic("jp", "pw") }));
            vi.advanceTimersByTime(300_001);
            await basicStrategy.authenticate(request("/mapi/emsmdb", { authorization: basic("jp", "pw") }));
            expect(fetcher).toHaveBeenCalledTimes(2);

            config.set("mail:basic_auth:cache_ttl_ms", 0);
            const uncached = authServer(() => ({ status: 200, token: tokenFor() }));
            const noCache = await strategy(uncached);
            await noCache.authenticate(request("/mapi/emsmdb", { authorization: basic("jp", "pw") }));
            await noCache.authenticate(request("/mapi/emsmdb", { authorization: basic("jp", "pw") }));
            expect(uncached).toHaveBeenCalledTimes(2);
        });

        it("forgets a remembered sign-in whose token no longer verifies", async () => {
            const expired = JWTUtils.createTokenSync({ ...config.get("auth"), options: { ...config.get("auth:options"), expiresIn: -60 } }, USER);
            const fetcher = authServer(() => ({ status: 200, token: tokenFor() }));
            const basicStrategy = await strategy(fetcher);
            (basicStrategy as any).tokens.set("stale", { token: expired, until: Date.now() + 60_000 });
            expect(await (basicStrategy as any).fromCache(request("/mapi"), "stale")).toBeUndefined();
            expect((basicStrategy as any).tokens.has("stale")).toBe(false);
        });

        it("bounds what it remembers", async () => {
            config.set("mail:basic_auth:cache_max_entries", 2);
            const fetcher = authServer(() => ({ status: 200, token: tokenFor() }));
            const basicStrategy = await strategy(fetcher);
            for (const name of ["a", "b", "c"]) {
                await basicStrategy.authenticate(request("/mapi/emsmdb", { authorization: basic(name, "pw") }));
            }
            expect((basicStrategy as any).tokens.size).toBe(2);
            config.set("mail:basic_auth:cache_max_entries", 5000);
        });

        it("ignores Basic credentials anywhere but the configured paths, with no challenge either", async () => {
            const fetcher = authServer(() => ({ status: 200, token: tokenFor() }));
            const { res, headers } = response();
            for (const path of ["/api/mail/mailboxes", "/api/admin/impersonate", "/", "/mapiary"]) {
                expect(await (await strategy(fetcher)).authenticate(request(path, { authorization: basic("jp", "pw") }), res)).toBeUndefined();
            }
            expect(fetcher).not.toHaveBeenCalled();
            expect(headers["WWW-Authenticate"]).toBeUndefined();
        });

        it("asks a client with no credentials to send Basic ones, on those paths only", async () => {
            const fetcher = authServer(() => ({ status: 200, token: tokenFor() }));
            const basicStrategy = await strategy(fetcher);
            const { res, headers } = response();
            expect(await basicStrategy.authenticate(request("/mapi/emsmdb"), res)).toBeUndefined();
            expect(headers["WWW-Authenticate"]).toBe('Basic realm="RapidMX", charset="UTF-8"');
            expect(fetcher).not.toHaveBeenCalled();

            const other = response();
            expect(await basicStrategy.authenticate(request("/api/mail/mailboxes"), other.res)).toBeUndefined();
            expect(other.headers["WWW-Authenticate"]).toBeUndefined();
        });

        it("refuses wrong credentials with the same challenge, and counts the failure", async () => {
            const fetcher = authServer(() => ({ status: 401 }));
            const basicStrategy = await strategy(fetcher);
            const { res, headers } = response();
            expect(await basicStrategy.authenticate(request("/mapi/emsmdb", { authorization: basic("jp", "wrong") }), res)).toBeUndefined();
            expect(headers["WWW-Authenticate"]).toContain("Basic");
            expect((basicStrategy as any).failures.get("name:jp").count).toBe(1);
        });

        it("stops asking auth-server after too many failures from one address or for one name, then allows it again", async () => {
            vi.useFakeTimers();
            config.set("mail:basic_auth:failure_limit", 3);
            const fetcher = authServer(() => ({ status: 401 }));
            const basicStrategy = await strategy(fetcher);
            // Three different names from one address.
            for (const name of ["a", "b", "c"]) {
                await basicStrategy.authenticate(request("/mapi/emsmdb", { authorization: basic(name, "x") }));
            }
            expect(fetcher).toHaveBeenCalledTimes(3);
            await expect(basicStrategy.authenticate(request("/mapi/emsmdb", { authorization: basic("d", "x") }))).rejects.toMatchObject({ status: 429 });
            expect(fetcher).toHaveBeenCalledTimes(3);
            // Another address is not held back by it...
            await basicStrategy.authenticate(request("/mapi/emsmdb", { authorization: basic("e", "x") }, "198.51.100.7"));
            expect(fetcher).toHaveBeenCalledTimes(4);
            // ...but one name tried from three addresses is.
            for (const address of ["192.0.2.1", "192.0.2.2", "192.0.2.3"]) {
                await basicStrategy.authenticate(request("/mapi/emsmdb", { authorization: basic("victim", "x") }, address));
            }
            await expect(basicStrategy.authenticate(request("/mapi/emsmdb", { authorization: basic("victim", "x") }, "192.0.2.4"))).rejects.toBeInstanceOf(ApiError);
            // The window passes.
            vi.advanceTimersByTime(900_001);
            await basicStrategy.authenticate(request("/mapi/emsmdb", { authorization: basic("d", "x") }));
            expect(fetcher).toHaveBeenCalledTimes(8);
        });

        it("clears a name's failures once it signs in", async () => {
            let good = false;
            const fetcher = authServer(() => (good ? { status: 200, token: tokenFor() } : { status: 401 }));
            const basicStrategy = await strategy(fetcher);
            await basicStrategy.authenticate(request("/mapi/emsmdb", { authorization: basic("jp", "typo") }));
            good = true;
            await basicStrategy.authenticate(request("/mapi/emsmdb", { authorization: basic("jp", "right") }));
            expect((basicStrategy as any).failures.has("name:jp")).toBe(false);
        });

        it("bounds the failures it keeps", async () => {
            config.set("mail:basic_auth:cache_max_entries", 1);
            const fetcher = authServer(() => ({ status: 401 }));
            const basicStrategy = await strategy(fetcher);
            for (let i = 0; i < 12; i++) {
                await basicStrategy.authenticate(request("/mapi/emsmdb", { authorization: basic(`user${i}`, "x") }, `192.0.2.${i + 1}`));
            }
            expect((basicStrategy as any).failures.size).toBeLessThanOrEqual(4);
            config.set("mail:basic_auth:cache_max_entries", 5000);
        });

        it("checks a mailbox address as the mailbox's owner, and anything else as given", async () => {
            const seen: string[] = [];
            const fetcher = authServer((name) => {
                seen.push(name);
                return { status: 200, token: tokenFor() };
            });
            const owned = await strategy(fetcher, [{ ownerUserUid: "owner-uid-1" }]);
            await owned.authenticate(request("/mapi/emsmdb", { authorization: basic("Jean-Philippe@Example.com", "pw") }));
            await owned.authenticate(request("/mapi/emsmdb", { authorization: basic("jp", "pw") }));
            expect(seen).toEqual(["owner-uid-1", "jp"]);

            // A shared mailbox has no owner, and an address with no mailbox is left to auth-server (an alias it may know).
            for (const mailboxes of [[{}], []]) {
                seen.length = 0;
                await (await strategy(fetcher, mailboxes)).authenticate(request("/mapi/emsmdb", { authorization: basic("shared@example.com", "pw") }));
                expect(seen).toEqual(["shared@example.com"]);
            }
        });

        it("sends the password on unchanged when it resolves the owner", async () => {
            const fetcher = authServer(() => ({ status: 200, token: tokenFor() }));
            await (await strategy(fetcher, [{ ownerUserUid: "owner-uid-1" }])).authenticate(
                request("/mapi/emsmdb", { authorization: basic("a@example.com", "p:w") }),
            );
            expect(fetcher.mock.calls[0][1].headers.Authorization).toBe(basic("owner-uid-1", "p:w"));
        });

        it("reports the sign-in service as unavailable, not the credentials as wrong, when auth-server can't be asked", async () => {
            for (const answer of [() => new Error("connect ECONNREFUSED"), () => ({ status: 502 })]) {
                const basicStrategy = await strategy(authServer(answer));
                await expect(basicStrategy.authenticate(request("/mapi/emsmdb", { authorization: basic("jp", "pw") }))).rejects.toMatchObject({ status: 503 });
                // Not held against the user.
                expect((basicStrategy as any).failures.size).toBe(0);
            }
            const brokenLookup: any = { newInstance: vi.fn(async () => ({ find: async () => Promise.reject(new Error("db down")) })) };
            const lookup = await objectFactory.newInstance<BasicAuthJWTStrategy>(BasicAuthJWTStrategy, {
                args: [jwt, brokenLookup, class Mailbox {}, authServer(() => ({ status: 200, token: tokenFor() }))],
            });
            await expect(lookup.authenticate(request("/mapi/emsmdb", { authorization: basic("a@example.com", "pw") }))).rejects.toMatchObject({ status: 503 });
        });

        it("refuses a token auth-server signed with something this server doesn't accept, and a reply with no token", async () => {
            const wrongKey = await strategy(authServer(() => ({ status: 200, token: tokenFor(USER, "another-secret") })));
            expect(await wrongKey.authenticate(request("/mapi/emsmdb", { authorization: basic("jp", "pw") }))).toBeUndefined();
            const noToken = await strategy(authServer(() => ({ status: 200 })));
            expect(await noToken.authenticate(request("/mapi/emsmdb", { authorization: basic("jp", "pw") }))).toBeUndefined();
        });

        it("tries Basic where a client sends both a JWT the real strategy rejects and Basic, and rethrows the JWT's failure when Basic fails too", async () => {
            const bad = `Bearer ${tokenFor(USER, "another-secret")}`;
            const fetcher = authServer((name) => (name === "jp" ? { status: 200, token: tokenFor() } : { status: 401 }));
            const basicStrategy = await strategy(fetcher);
            // Only one Authorization header per request, so the bad JWT rides in the cookie.
            const withCookie = (headers: Record<string, string>) => ({ ...request("/mapi/emsmdb", headers), cookies: { jwt: bad.slice(7) } });
            expect((await basicStrategy.authenticate(withCookie({ authorization: basic("jp", "pw") })))?.user?.uid).toBe(USER.uid);
            await expect(basicStrategy.authenticate(withCookie({ authorization: basic("nobody", "pw") }))).rejects.toBeDefined();
            // A JWT the real strategy rejects, with no Basic to fall back on, is that strategy's failure.
            await expect(basicStrategy.authenticate(request("/api/mail/mailboxes", { authorization: bad }))).rejects.toBeDefined();
        });

        it("does nothing extra when turned off, or with no auth-server to ask", async () => {
            const fetcher = authServer(() => ({ status: 200, token: tokenFor() }));
            config.set("mail:basic_auth:enabled", false);
            const off = await strategy(fetcher);
            const { res, headers } = response();
            expect(await off.authenticate(request("/mapi/emsmdb", { authorization: basic("jp", "pw") }), res)).toBeUndefined();
            expect(headers["WWW-Authenticate"]).toBeUndefined();
            config.set("mail:basic_auth:enabled", true);

            config.set("mail:auth_server_url", "");
            expect(await (await strategy(fetcher)).authenticate(request("/mapi/emsmdb", { authorization: basic("jp", "pw") }))).toBeUndefined();
            config.set("mail:auth_server_url", AUTH_SERVER);
            expect(fetcher).not.toHaveBeenCalled();
        });

        it("has the name 'jwt', so it takes the real strategy's place, and can't check Basic credentials synchronously", async () => {
            const basicStrategy = await strategy(authServer(() => ({ status: 401 })));
            expect(basicStrategy.name).toBe("jwt");
            expect(basicStrategy.authenticateSync(request("/mapi/emsmdb", { authorization: basic("jp", "pw") }))).toBeUndefined();
            expect(basicStrategy.authenticateSync(request("/mapi/emsmdb", { authorization: `Bearer ${tokenFor()}` }))?.user?.uid).toBe(USER.uid);
        });

        it("treats a request with no address as one address, and honors the gateway's forwarded address", async () => {
            config.set("mail:basic_auth:failure_limit", 1);
            const fetcher = authServer(() => ({ status: 401 }));
            const basicStrategy = await strategy(fetcher);
            const noAddress = { ...request("/mapi/emsmdb", { authorization: basic("a", "x") }), socket: undefined };
            await basicStrategy.authenticate(noAddress);
            expect((basicStrategy as any).failures.has("ip:unknown")).toBe(true);
            (basicStrategy as any).trustedProxies = ["10.0.0.0/8"];
            (basicStrategy as any).trustedList = undefined;
            await basicStrategy.authenticate(request("/mapi/emsmdb", { authorization: basic("b", "x"), "x-forwarded-for": "198.51.100.77, 10.1.1.1" }, "10.2.2.2"));
            expect((basicStrategy as any).failures.has("ip:198.51.100.77")).toBe(true);
        });
    });

    describe("enableBasicAuthIfApplicable()", () => {
        function fakeApp(strategies: Map<string, AuthStrategy>) {
            const registered: AuthStrategy[] = [];
            const middleware: any = { strategies, register: (_name: string, strategy: AuthStrategy) => registered.push(strategy) };
            const factory: any = {
                newInstance: vi.fn(async (clazz: any, options?: any) => (clazz.name === "AuthMiddleware" ? middleware : new BasicAuthJWTStrategy(options.args[0], options.args[1], options.args[2]))),
            };
            return { factory, registered };
        }
        const logger = () => ({ warn: vi.fn(), info: vi.fn() });

        it("puts the strategy in front of jwt", async () => {
            const { factory, registered } = fakeApp(new Map([["jwt", jwt]]));
            const log = logger();
            await enableBasicAuthIfApplicable(factory, config, log, class Mailbox {});
            expect(registered).toHaveLength(1);
            expect(registered[0]).toBeInstanceOf(BasicAuthJWTStrategy);
            expect(log.info).toHaveBeenCalled();
        });

        it("does nothing when it is switched off, and says why when there is nothing to build on or ask", async () => {
            const off = fakeApp(new Map([["jwt", jwt]]));
            config.set("mail:basic_auth:enabled", false);
            await enableBasicAuthIfApplicable(off.factory, config, logger(), class Mailbox {});
            expect(off.factory.newInstance).not.toHaveBeenCalled();
            config.set("mail:basic_auth:enabled", true);

            const noJwt = fakeApp(new Map());
            const log = logger();
            await enableBasicAuthIfApplicable(noJwt.factory, config, log, class Mailbox {});
            expect(noJwt.registered).toHaveLength(0);
            expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/no jwt authentication strategy/));

            config.set("mail:auth_server_url", "");
            const noServer = fakeApp(new Map([["jwt", jwt]]));
            const log2 = logger();
            await enableBasicAuthIfApplicable(noServer.factory, config, log2, class Mailbox {});
            expect(noServer.factory.newInstance).not.toHaveBeenCalled();
            expect(log2.warn).toHaveBeenCalledWith(expect.stringMatching(/mail:auth_server_url/));
            config.set("mail:auth_server_url", AUTH_SERVER);
        });
    });
});
