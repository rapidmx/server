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
import { KEYRING_SECRET_KEY, KubernetesConfigKeyringStore } from "../../src/secrets/KubernetesConfigKeyringStore.js";
import { FakeKubernetes } from "./fakeKubernetes.js";

const SECRET = "rel-config-keyring";
const b64 = (text: string): string => Buffer.from(text, "utf-8").toString("base64");
const decode = (data: string): ConfigKeyring => parseConfigKeyring(Buffer.from(data, "base64").toString("utf-8"));

describe("KubernetesConfigKeyringStore", () => {
    let kube: FakeKubernetes;
    let ring: ConfigKeyring;

    async function store(secretName: string = SECRET): Promise<KubernetesConfigKeyringStore> {
        return new KubernetesConfigKeyringStore({ secretName, kube: await kube.client() });
    }

    beforeEach(() => {
        kube = new FakeKubernetes();
        ring = generateConfigKeyring();
        kube.addSecret(
            SECRET,
            { [KEYRING_SECRET_KEY]: b64(serializeConfigKeyring(ring)), other: b64("kept") },
            { labels: { app: "rapidmx" }, annotations: { "meta.helm.sh/release-name": "rel" } },
        );
    });

    it("reads the keyring from the Secret's keyring.json, versioned by the Secret's resourceVersion", async () => {
        const snapshot = await (await store()).read();
        expect(snapshot.keyring).toEqual(ring);
        expect(snapshot.version).toBe(kube.secrets.get(SECRET)!.metadata.resourceVersion);
        expect(kube.requests.map((request) => `${request.method ?? "GET"} ${request.url.pathname}`)).toEqual([`GET /api/v1/namespaces/mail/secrets/${SECRET}`]);
    });

    it("adds a key by replacing the Secret at the version it read, keeping its other data, labels and annotations", async () => {
        const target = await store();
        const { keyring, version } = await target.read();
        const added = generateConfigKey();
        await target.write({ keys: [...keyring.keys, added] }, version);

        const saved = kube.secrets.get(SECRET)!;
        expect(decode(saved.data[KEYRING_SECRET_KEY]).keys.map((key) => key.kid)).toEqual([ring.keys[0].kid, added.kid]);
        expect(saved.data.other).toBe(b64("kept"));
        expect(saved.metadata.labels).toEqual({ app: "rapidmx" });
        expect(saved.metadata.annotations).toEqual({ "meta.helm.sh/release-name": "rel" });
        expect(saved.type).toBe("Opaque");
        expect(saved.metadata.resourceVersion).not.toBe(version);
        // The version moved, so a second write at the old one is a conflict.
        await expect(target.write(keyring, version)).rejects.toBeInstanceOf(ConfigKeyringConflictError);
    });

    it("sends the resourceVersion it was given, and no server-managed fields", async () => {
        const target = await store();
        const { keyring, version } = await target.read();
        await target.write(keyring, version);
        const put = kube.requests.find((request) => request.method === "PUT")!;
        const body = JSON.parse(put.body!);
        expect(body.metadata.resourceVersion).toBe(version);
        expect(body.metadata.name).toBe(SECRET);
        expect(body.metadata.managedFields).toBeUndefined();
    });

    it("is a conflict, with nothing written, when the Secret changed since it was read", async () => {
        const target = await store();
        const { keyring, version } = await target.read();
        const other = generateConfigKeyring();
        kube.touch(SECRET, { [KEYRING_SECRET_KEY]: b64(serializeConfigKeyring(other)) });
        await expect(target.write({ keys: [...keyring.keys, generateConfigKey()] }, version)).rejects.toBeInstanceOf(ConfigKeyringConflictError);
        expect(kube.requests.filter((request) => request.method === "PUT")).toHaveLength(0);
        expect(decode(kube.secrets.get(SECRET)!.data[KEYRING_SECRET_KEY])).toEqual(other);
    });

    it("is a conflict when the API server refuses the PUT's resourceVersion, because another writer got in between", async () => {
        const target = await store();
        const { keyring, version } = await target.read();
        const other = generateConfigKeyring();
        kube.beforePut = () => kube.touch(SECRET, { [KEYRING_SECRET_KEY]: b64(serializeConfigKeyring(other)) });
        await expect(target.write({ keys: [...keyring.keys, generateConfigKey()] }, version)).rejects.toBeInstanceOf(ConfigKeyringConflictError);
        expect(decode(kube.secrets.get(SECRET)!.data[KEYRING_SECRET_KEY])).toEqual(other);
    });

    it("touches only the one Secret it is named for", async () => {
        kube.addSecret("rel-jwt", { secret: b64("do-not-touch") });
        const target = await store();
        const { keyring, version } = await target.read();
        await target.write(keyring, version);
        expect([...new Set(kube.requests.map((request) => request.url.pathname))]).toEqual([`/api/v1/namespaces/mail/secrets/${SECRET}`]);
        expect(kube.secrets.get("rel-jwt")!.data.secret).toBe(b64("do-not-touch"));
    });

    it("refuses a ring that is not a usable keyring before writing anything", async () => {
        const target = await store();
        const { version } = await target.read();
        await expect(target.write({ keys: [] }, version)).rejects.toBeInstanceOf(ConfigKeyringInvalidError);
        await expect(target.write({ keys: [{ kid: "x", key: "short", createdAt: "2026-01-01T00:00:00Z" }] }, version)).rejects.toBeInstanceOf(ConfigKeyringInvalidError);
        expect(kube.requests.filter((request) => request.method === "PUT")).toHaveLength(0);
    });

    it("says a Secret without a parseable keyring is invalid, never repeating its text", async () => {
        kube.touch(SECRET, { [KEYRING_SECRET_KEY]: b64('{"keys": "a1b2c3-secret-material"') });
        const broken = await (await store()).read().catch((e) => e);
        expect(broken).toBeInstanceOf(ConfigKeyringInvalidError);
        expect(broken.message).not.toMatch(/a1b2c3/);

        kube.touch(SECRET, { other: b64("x") });
        expect(await (await store()).read().catch((e) => e)).toBeInstanceOf(ConfigKeyringInvalidError);

        kube.touch(SECRET, { [KEYRING_SECRET_KEY]: "!!! not base64 !!!" });
        expect(await (await store()).read().catch((e) => e)).toBeInstanceOf(ConfigKeyringInvalidError);
    });

    it("fails with an ordinary error, to be retried, when the Secret or the API can't be reached", async () => {
        const missing = await (await store("rel-other")).read().catch((e) => e);
        expect(missing).toBeInstanceOf(Error);
        expect(missing).not.toBeInstanceOf(ConfigKeyringInvalidError);
        expect(missing.message).toMatch(/HTTP 404/);

        kube.failWith = 403;
        const forbidden = await (await store()).write(ring, "1").catch((e) => e);
        expect(forbidden).not.toBeInstanceOf(ConfigKeyringConflictError);
        expect(forbidden.message).toMatch(/HTTP 403/);
    });

    it("needs a Secret name and a pod with a service account", async () => {
        await expect(new KubernetesConfigKeyringStore({ secretName: "", kube: await kube.client() }).read()).rejects.toThrow(/secret_name isn't set/);
        const outside = new KubernetesConfigKeyringStore({ secretName: SECRET, env: {} });
        await expect(outside.read()).rejects.toThrow(/not running in Kubernetes/);
    });

    it("never puts key material in an error", async () => {
        const { kid, key } = ring.keys[0];
        kube.failWith = 500;
        const errors = await Promise.all([(await store()).read().catch((e) => e), (await store()).write(ring, "1").catch((e) => e)]);
        for (const error of errors) {
            expect(String(error.message)).not.toContain(key);
            expect(String(error.message)).not.toContain(kid);
        }
    });
});
