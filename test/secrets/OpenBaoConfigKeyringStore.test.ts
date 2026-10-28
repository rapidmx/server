///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
import {
    ConfigKeyringConflictError,
    ConfigKeyringInvalidError,
    generateConfigKey,
    generateConfigKeyring,
    parseConfigKeyring,
    serializeConfigKeyring,
    type ConfigKeyring,
} from "@rapidmx/restapi";
import { OpenBaoClient, type OpenBaoHttpRequest, type OpenBaoHttpResponse } from "../../src/openbao/OpenBaoClient.js";
import { OpenBaoConfigKeyringStore } from "../../src/secrets/OpenBaoConfigKeyringStore.js";

const JWT = "eyJhbGciOiJSUzI1NiJ9.service-account.signature";
const json = (status: number, body: unknown): OpenBaoHttpResponse => ({ status, body: JSON.stringify(body) });

/**
 * A fake OpenBao with a KV v2 mount: the one secret `secret/<path>` with versions and check-and-set, a Kubernetes login, and a 403 for every other path
 * (which is what the server's policy answers).
 */
class FakeOpenBao {
    public readonly requests: OpenBaoHttpRequest[] = [];
    public version = 3;
    public text: string | undefined;
    /** Changes the secret when a write arrives, before it is judged: another writer getting in between. */
    public beforeWrite?: () => void;
    public failWith?: OpenBaoHttpResponse;

    constructor(
        public readonly mount: string = "secret",
        public readonly path: string = "rel/config-keyring",
    ) {}

    public readonly transport = async (request: OpenBaoHttpRequest): Promise<OpenBaoHttpResponse> => {
        this.requests.push(request);
        if (request.url.pathname === "/v1/auth/kubernetes/login") {
            return json(200, { auth: { client_token: "s.token", lease_duration: 3600 } });
        }
        if (this.failWith) {
            return this.failWith;
        }
        const data = `/v1/${this.mount}/data/${this.path}`;
        if (request.url.pathname === data && request.method === "GET") {
            return this.text === undefined
                ? json(404, { errors: [] })
                : json(200, { data: { data: { keyring: this.text }, metadata: { version: this.version, created_time: "2026-10-28T00:00:00Z" } } });
        }
        if (request.url.pathname === data && request.method === "POST") {
            this.beforeWrite?.();
            const body: any = JSON.parse(request.body ?? "{}");
            if (body.options?.cas !== this.version) {
                return json(400, { errors: ["check-and-set parameter did not match the current version"] });
            }
            this.text = body.data.keyring;
            this.version += 1;
            return json(200, { data: { version: this.version } });
        }
        return json(403, { errors: ["1 error occurred:\n\t* permission denied"] });
    };

    public client(): OpenBaoClient {
        return new OpenBaoClient({
            name: "mail:pki:openbao",
            address: "https://openbao.openbao.svc:8200",
            auth: { method: "kubernetes", role: "rel-server", mountPath: "kubernetes", tokenFile: "/var/run/secrets/openbao/token" },
            transport: this.transport,
            readFile: async () => JWT,
        });
    }
}

describe("OpenBaoConfigKeyringStore", () => {
    let bao: FakeOpenBao;
    let ring: ConfigKeyring;

    const store = (overrides: { mount?: string; path?: string } = {}): OpenBaoConfigKeyringStore =>
        new OpenBaoConfigKeyringStore({ client: bao.client(), mount: bao.mount, path: bao.path, ...overrides });

    beforeEach(() => {
        bao = new FakeOpenBao();
        ring = generateConfigKeyring();
        bao.text = serializeConfigKeyring(ring);
    });

    it("reads the keyring from the keyring property of the KV secret, versioned by the KV version", async () => {
        const snapshot = await store().read();
        expect(snapshot.keyring).toEqual(ring);
        expect(snapshot.version).toBe("3");
        const read = bao.requests.find((request) => request.method === "GET")!;
        expect(read.url.pathname).toBe("/v1/secret/data/rel/config-keyring");
        expect(read.headers["X-Vault-Token"]).toBe("s.token");
    });

    it("writes with check-and-set at the version it read, putting the ring in the keyring property", async () => {
        const target = store();
        const { keyring, version } = await target.read();
        const added = generateConfigKey();
        await target.write({ keys: [...keyring.keys, added] }, version);

        const write = bao.requests.find((request) => request.method === "POST" && request.url.pathname.includes("/data/"))!;
        expect(JSON.parse(write.body!)).toEqual({ options: { cas: 3 }, data: { keyring: expect.any(String) } });
        expect(parseConfigKeyring(bao.text).keys.map((key) => key.kid)).toEqual([ring.keys[0].kid, added.kid]);
        expect(bao.version).toBe(4);
        // The version moved, so another write at the old one is refused.
        await expect(target.write(keyring, version)).rejects.toBeInstanceOf(ConfigKeyringConflictError);
    });

    it("is a conflict, leaving the secret alone, when the version moved between the read and the write", async () => {
        const target = store();
        const { keyring, version } = await target.read();
        const other = generateConfigKeyring();
        bao.beforeWrite = () => {
            bao.text = serializeConfigKeyring(other);
            bao.version += 1;
        };
        await expect(target.write({ keys: [...keyring.keys, generateConfigKey()] }, version)).rejects.toBeInstanceOf(ConfigKeyringConflictError);
        expect(parseConfigKeyring(bao.text)).toEqual(other);
    });

    it("touches only the keyring's KV path, with the mount and path it is configured for", async () => {
        const moved = new FakeOpenBao("kv", "rapidmx/config-keyring");
        moved.text = serializeConfigKeyring(ring);
        const target = new OpenBaoConfigKeyringStore({ client: moved.client(), mount: "kv", path: "rapidmx/config-keyring" });
        const { keyring, version } = await target.read();
        await target.write(keyring, version);
        const paths = moved.requests.map((request) => request.url.pathname).filter((p) => !p.startsWith("/v1/auth/"));
        expect(paths).toEqual(["/v1/kv/data/rapidmx/config-keyring", "/v1/kv/data/rapidmx/config-keyring"]);
    });

    it("refuses a ring that is not a usable keyring before sending it", async () => {
        const target = store();
        const { version } = await target.read();
        await expect(target.write({ keys: [] }, version)).rejects.toBeInstanceOf(ConfigKeyringInvalidError);
        expect(bao.requests.filter((request) => request.method === "POST" && request.url.pathname.includes("/data/"))).toHaveLength(0);
    });

    it("says a secret without a parseable keyring is invalid, never repeating its text", async () => {
        bao.text = '{"keys": "a1b2c3-secret-material"';
        const broken = await store().read().catch((e) => e);
        expect(broken).toBeInstanceOf(ConfigKeyringInvalidError);
        expect(broken.message).not.toMatch(/a1b2c3/);
    });

    it("fails with an ordinary error, to be retried, for a missing secret, a sealed vault or a policy that refuses", async () => {
        bao.text = undefined;
        const missing = await store().read().catch((e) => e);
        expect(missing).not.toBeInstanceOf(ConfigKeyringInvalidError);
        expect(missing.message).toMatch(/HTTP 404/);

        bao.text = serializeConfigKeyring(ring);
        bao.failWith = json(503, { errors: ["Vault is sealed"] });
        const sealed = await store().write(ring, "3").catch((e) => e);
        expect(sealed).not.toBeInstanceOf(ConfigKeyringConflictError);
        expect(sealed.message).toMatch(/HTTP 503/);

        bao.failWith = undefined;
        const other = await store({ path: "rel/secrets" }).read().catch((e) => e);
        expect(other.message).toMatch(/HTTP 403/);
    });

    it("needs a path, and refuses a mount or path that could reach another secret", async () => {
        await expect(store({ path: "" }).read()).rejects.toThrow(/kv_path isn't set/);
        for (const path of ["../secrets", "rel/../secrets", "/rel/config-keyring", "rel//x", "rel/config keyring?x=1"]) {
            await expect(store({ path }).read(), path).rejects.toThrow(/kv_path/);
        }
        for (const mount of ["", "../sys", "secret/data", "a b"]) {
            await expect(store({ mount }).read(), mount).rejects.toThrow(/kv_mount/);
        }
        expect(bao.requests).toHaveLength(0);
    });

    it("never puts key material in an error", async () => {
        const { kid, key } = ring.keys[0];
        bao.failWith = json(500, { errors: [`internal error ${key}`] });
        const errors = await Promise.all([store().read().catch((e) => e), store().write(ring, "3").catch((e) => e)]);
        for (const error of errors) {
            // OpenBao's own error text may name a problem (up to 300 characters of it); the keyring we hold is not part of any message we compose.
            expect(String(error.message)).not.toContain(kid);
        }
        expect(errors[1].message).toMatch(/HTTP 500/);
    });
});
