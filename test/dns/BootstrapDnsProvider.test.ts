///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
// The installer's DNS provider config (restapi spec 12.1, 13.3): created once at start-up from `mail:dns:bootstrap_provider` and the credentials of the
// `<fullname>-dns-bootstrap` Secret the server pod mounts, encrypted in the row, idempotent, and never a reason for the server not to start.
import fs from "fs";
import os from "os";
import path from "path";
import { dnsCredentialContext, getDnsProviderType, type ConfigCipher } from "@rapidmx/restapi";
import {
    createBootstrapDnsProvider,
    DEFAULT_BOOTSTRAP_CREDENTIALS_DIR,
    parseBootstrapProvider,
    readBootstrapCredentials,
} from "../../src/dns/BootstrapDnsProvider.js";
import { keyringCipher, layeredConfig, logger } from "../helpers/integrations.js";

const ZONE_ID = "0123456789abcdef0123456789abcdef";
const TOKEN = "cf-secret-token-0123456789";

const CLOUDFLARE = { name: "Installer Cloudflare", type: "cloudflare", zones: ["example.com"], options: { zoneIds: [ZONE_ID] } };

class Row {
    public version: number = 0;
    constructor(fields: Record<string, any>) {
        Object.assign(this, fields);
    }
}

/** The part of a `RepoUtils` the creation uses, over a list: the unique index on `nameKey` is the backend's, so it is optional here. */
class FakeRepo {
    public rows: any[] = [];
    public create = vi.fn(async (entity: any) => {
        if (this.failCreate) {
            throw this.failCreate;
        }
        this.rows.push(entity);
        return entity;
    });
    public failCreate?: Error;
    public find = vi.fn(async (query: Record<string, unknown>) => {
        const { sort: _sort, limit, page, ...match } = query as any;
        const matching = this.rows.filter((row) => Object.entries(match).every(([key, value]) => row[key] === value));
        const size: number = Number(limit) || matching.length;
        return matching.slice(Number(page ?? 0) * size, (Number(page ?? 0) + 1) * size);
    });
    constructor(rows: any[] = []) {
        this.rows = rows;
    }
}

/** The part of a `RepoUtils` that `updateSetupState()` uses on the one setup row. */
class FakeSetupRepo {
    public row?: any;
    public findOne = vi.fn(async (_uid: string) => this.row);
    public create = vi.fn(async (entity: any) => {
        this.row = new Row({ ...entity });
        return this.row;
    });
    public update = vi.fn(async (patch: any, _existing: any) => {
        Object.assign(this.row, patch, { version: this.row.version + 1 });
        return this.row;
    });
}

describe("parseBootstrapProvider", () => {
    it("takes the provider config as an object or as the JSON text the chart renders into the ConfigMap", () => {
        const expected = {
            name: "Installer Cloudflare",
            type: "cloudflare",
            zones: ["example.com"],
            options: { zoneIds: [ZONE_ID] },
            allowTakeover: false,
        };
        expect(parseBootstrapProvider(CLOUDFLARE)).toEqual({ provider: expected });
        expect(parseBootstrapProvider(JSON.stringify(CLOUDFLARE))).toEqual({ provider: expected });
    });

    it("says there is none for a deployment that wasn't installed with a provider", () => {
        for (const value of [undefined, null, "", "  ", {}, "{}"]) {
            expect(parseBootstrapProvider(value)).toEqual({});
        }
    });

    it("takes allowTakeover, which is what the installer's --dns-takeover sets", () => {
        expect(parseBootstrapProvider({ ...CLOUDFLARE, allowTakeover: true }).provider?.allowTakeover).toBe(true);
        expect(parseBootstrapProvider({ ...CLOUDFLARE, allowTakeover: "yes" }).problem).toMatch(/allowTakeover/);
    });

    it("normalizes the zones and options as the console's create does, with every default filled in", () => {
        const { provider } = parseBootstrapProvider({ name: "  Aws  ", type: "route53", zones: ["Example.COM."], options: { region: "US-EAST-1" } });
        expect(provider).toMatchObject({ name: "Aws", zones: ["example.com"], options: { region: "us-east-1", zoneType: "public" } });
    });

    it("refuses, naming what is wrong and never repeating more than that, what the console would", () => {
        expect(parseBootstrapProvider("{not json").problem).toMatch(/JSON/);
        expect(parseBootstrapProvider([CLOUDFLARE]).problem).toMatch(/object/);
        expect(parseBootstrapProvider({ ...CLOUDFLARE, dnsprovider: "x" }).problem).toMatch(/dnsprovider/);
        expect(parseBootstrapProvider({ ...CLOUDFLARE, name: "" }).problem).toMatch(/name/);
        expect(parseBootstrapProvider({ ...CLOUDFLARE, type: "digitalocean" }).problem).toMatch(/type/i);
        expect(parseBootstrapProvider({ ...CLOUDFLARE, zones: ["com"] }).problem).toMatch(/zone/i);
        expect(parseBootstrapProvider({ ...CLOUDFLARE, options: {} }).problem).toMatch(/zoneIds/);
        expect(parseBootstrapProvider({ ...CLOUDFLARE, options: { zoneIds: [ZONE_ID], proxied: true } }).problem).toMatch(/Unknown option/);
    });
});

describe("readBootstrapCredentials", () => {
    let dir: string;
    const cloudflare = getDnsProviderType("cloudflare");

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "dns-bootstrap-"));
    });
    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it("mounts the Secret under /etc/rapidmx, as the keyring and the OpenBao CA are", () => {
        expect(DEFAULT_BOOTSTRAP_CREDENTIALS_DIR).toBe("/etc/rapidmx/dns-bootstrap");
    });

    it("reads one file per credential field of the type, without the newline a file usually ends with", async () => {
        fs.writeFileSync(path.join(dir, "apiToken"), `${TOKEN}\n`);
        expect(await readBootstrapCredentials(dir, cloudflare)).toEqual({ apiToken: TOKEN });
    });

    it("reads nothing where no Secret is mounted (the volume is optional)", async () => {
        expect(await readBootstrapCredentials(path.join(dir, "missing"), cloudflare)).toEqual({});
        expect(await readBootstrapCredentials(dir, cloudflare)).toEqual({});
    });

    it("keeps a file's content whole for the fields that hold one (Google's key file)", async () => {
        fs.writeFileSync(path.join(dir, "serviceAccountJson"), '{\n  "type": "service_account"\n}\n');
        expect(await readBootstrapCredentials(dir, getDnsProviderType("google"))).toEqual({ serviceAccountJson: '{\n  "type": "service_account"\n}' });
    });

    it("leaves out a file that isn't a field of the type, saying so by name, and the entries Kubernetes keeps in a mounted Secret", async () => {
        fs.writeFileSync(path.join(dir, "apiToken"), TOKEN);
        fs.writeFileSync(path.join(dir, "api_token"), "a typo");
        fs.writeFileSync(path.join(dir, "..data"), "kubernetes");
        const log = logger();
        expect(await readBootstrapCredentials(dir, cloudflare, log)).toEqual({ apiToken: TOKEN });
        expect(log.warn).toHaveBeenCalledTimes(1);
        expect(log.warn.mock.calls[0][0]).toContain("api_token");
        expect(log.warn.mock.calls[0][0]).not.toContain("a typo");
    });

    it("ignores a field whose file is empty, rather than saving an empty credential", async () => {
        fs.writeFileSync(path.join(dir, "apiToken"), "\n");
        expect(await readBootstrapCredentials(dir, cloudflare)).toEqual({});
    });

    it("refuses a value the console would, naming the field and never the value", async () => {
        fs.writeFileSync(path.join(dir, "apiToken"), "leak-marker\u0001");
        const control: Error = await readBootstrapCredentials(dir, cloudflare).then(
            () => new Error("accepted"),
            (err) => err,
        );
        expect(control.message).toMatch(/apiToken/);
        expect(control.message).not.toContain("leak-marker");
        fs.writeFileSync(path.join(dir, "accessKeyId"), "not-an-access-key!");
        const format: Error = await readBootstrapCredentials(dir, getDnsProviderType("route53")).then(
            () => new Error("accepted"),
            (err) => err,
        );
        expect(format.message).toMatch(/accessKeyId/);
        expect(format.message).not.toContain("not-an-access-key");
    });
});

describe("createBootstrapDnsProvider", () => {
    let dir: string;
    let cipher: ConfigCipher;
    let providers: FakeRepo;
    let domains: FakeRepo;
    let setupState: FakeSetupRepo;
    let audit: { record: ReturnType<typeof vi.fn> };
    let publisher: { changed: ReturnType<typeof vi.fn> };
    let log: ReturnType<typeof logger>;

    beforeEach(async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "dns-bootstrap-"));
        fs.writeFileSync(path.join(dir, "apiToken"), `${TOKEN}\n`);
        ({ cipher } = await keyringCipher(layeredConfig()));
        providers = new FakeRepo();
        domains = new FakeRepo();
        setupState = new FakeSetupRepo();
        audit = { record: vi.fn(async () => undefined) };
        publisher = { changed: vi.fn(async () => undefined) };
        log = logger();
    });
    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    const create = (value: unknown = CLOUDFLARE, overrides: Record<string, unknown> = {}) =>
        createBootstrapDnsProvider({
            value,
            credentialsDir: dir,
            providers: providers as any,
            domains: domains as any,
            setupState: setupState as any,
            providerClass: Row as any,
            cipher,
            audit,
            publisher: publisher as any,
            logger: log,
            ...overrides,
        });

    it("creates the installer's config: origin installer, enabled, its credentials sealed for the row and the field, generation 1", async () => {
        const result = await create();
        expect(result.status).toBe("created");
        expect(providers.rows).toHaveLength(1);
        const row = providers.rows[0];
        expect(row).toMatchObject({
            name: "Installer Cloudflare",
            nameKey: "installer cloudflare",
            type: "cloudflare",
            zones: ["example.com"],
            options: { zoneIds: [ZONE_ID] },
            origin: "installer",
            enabled: true,
            allowTakeover: false,
            credentialsGeneration: 1,
        });
        expect(row.uid).toMatch(/^installer-cloudflare-[a-z0-9]{8}$/);
        expect(result).toEqual({ status: "created", uid: row.uid });
        // Only the envelope is in the row, and it opens for this row and field only.
        expect(JSON.stringify(row)).not.toContain(TOKEN);
        expect(cipher.decryptString(row.credentials.apiToken, dnsCredentialContext(row.uid, "apiToken"))).toBe(TOKEN);
        expect(() => cipher.decryptString(row.credentials.apiToken, dnsCredentialContext("another-row", "apiToken"))).toThrow();
    });

    it("sets allowTakeover from the installer's --dns-takeover", async () => {
        await create({ ...CLOUDFLARE, allowTakeover: true });
        expect(providers.rows[0].allowTakeover).toBe(true);
    });

    it("creates a config that needs no credentials without any (Route 53 through IRSA)", async () => {
        const result = await create({ name: "Aws", type: "route53", zones: ["example.com"], options: { region: "us-east-1" } });
        expect(result.status).toBe("created");
        expect(providers.rows[0].credentials).toBeUndefined();
        expect(providers.rows[0].credentialsGeneration).toBeUndefined();
    });

    it("audits the creation without a value and tells the DNS controller", async () => {
        const result = await create();
        const uid = (result as any).uid;
        expect(audit.record).toHaveBeenCalledTimes(1);
        const [params, caller] = audit.record.mock.calls[0];
        expect(params).toMatchObject({
            action: "dns_provider.create",
            targetType: "DnsProvider",
            targetUid: uid,
            details: { name: "Installer Cloudflare", type: "cloudflare", zones: ["example.com"], optionKeys: ["zoneIds"], credentialsChanged: true, origin: "installer" },
        });
        // The server did it, not a user.
        expect(caller ?? {}).toEqual({});
        expect(JSON.stringify(audit.record.mock.calls)).not.toContain(TOKEN);
        expect(publisher.changed).toHaveBeenCalledWith({ scope: "provider", providerUid: uid });
    });

    it("is idempotent: a deployment that has the installer's config is left alone, however its credentials or the config changed", async () => {
        await create();
        expect(providers.rows).toHaveLength(1);
        fs.writeFileSync(path.join(dir, "apiToken"), "rotated-token");
        const again = await create({ ...CLOUDFLARE, zones: ["other.example.org"], options: { zoneIds: [ZONE_ID] } });
        expect(again).toEqual({ status: "exists", uid: providers.rows[0].uid });
        expect(providers.rows).toHaveLength(1);
        expect(providers.create).toHaveBeenCalledTimes(1);
        expect(audit.record).toHaveBeenCalledTimes(1);
        expect(publisher.changed).toHaveBeenCalledTimes(1);
    });

    it("leaves a config the administrator made in the console alone, and creates the installer's beside it", async () => {
        providers.rows.push(new Row({ uid: "console-aaaa1111", name: "Mine", nameKey: "mine", zones: ["other.org"], origin: "console" }));
        expect((await create()).status).toBe("created");
        expect(providers.rows).toHaveLength(2);
    });

    it("does nothing for a deployment installed without a provider, without touching the datastore", async () => {
        expect(await create("")).toEqual({ status: "none" });
        expect(await create({})).toEqual({ status: "none" });
        expect(providers.find).not.toHaveBeenCalled();
        expect(providers.create).not.toHaveBeenCalled();
    });

    it("takes a creation another server copy won as the config being there, auditing and announcing nothing", async () => {
        providers.failCreate = Object.assign(new Error("E11000 duplicate key error collection: DnsProvider index: nameKey"), { code: 11000 });
        expect(await create()).toEqual({ status: "exists" });
        expect(audit.record).not.toHaveBeenCalled();
        expect(publisher.changed).not.toHaveBeenCalled();
        expect(log.error).not.toHaveBeenCalled();
    });

    describe("is created once, however the administrator edits it afterwards", () => {
        it("records on the setup row that it created the config", async () => {
            const result = await create();
            expect(setupState.row.bootstrapDnsProviderUid).toBe((result as any).uid);
            expect(log.warn).not.toHaveBeenCalled();
        });

        it("does not create it again once the administrator deleted it in the console, at any later start", async () => {
            await create();
            providers.rows.length = 0;
            for (let start = 0; start < 2; start++) {
                expect(await create()).toEqual({ status: "exists" });
            }
            expect(providers.rows).toHaveLength(0);
            expect(providers.create).toHaveBeenCalledTimes(1);
            expect(audit.record).toHaveBeenCalledTimes(1);
            expect(publisher.changed).toHaveBeenCalledTimes(1);
            expect(log.error).not.toHaveBeenCalled();
        });

        it("records a config that is there without a record, so deleting it is final too", async () => {
            providers.rows.push(new Row({ uid: "installer-aws-aaaa1111", name: "Aws", nameKey: "aws", zones: ["example.com"], origin: "installer" }));
            expect(await create()).toEqual({ status: "exists", uid: "installer-aws-aaaa1111" });
            expect(setupState.row.bootstrapDnsProviderUid).toBe("installer-aws-aaaa1111");
        });

        it("keeps the record another copy made, and takes the config that copy won with as the one recorded", async () => {
            setupState.row = new Row({ uid: "setup-state", bootstrapDnsProviderUid: "installer-winner-bbbb2222" });
            providers.rows.push(new Row({ uid: "installer-winner-bbbb2222", name: "Winner", nameKey: "winner", zones: ["example.com"], origin: "installer" }));
            await create();
            expect(setupState.update).not.toHaveBeenCalled();

            setupState.row = undefined;
            providers.rows.length = 0;
            providers.create.mockImplementationOnce(async () => {
                providers.rows.push(new Row({ uid: "installer-racer-cccc3333", name: "Racer", nameKey: "racer", zones: ["example.com"], origin: "installer" }));
                throw Object.assign(new Error("E11000 duplicate key error"), { code: 11000 });
            });
            expect(await create()).toEqual({ status: "exists" });
            expect(setupState.row.bootstrapDnsProviderUid).toBe("installer-racer-cccc3333");
        });

        it("creates nothing when the setup row can't be read, as it might say the config was deleted", async () => {
            setupState.findOne.mockRejectedValueOnce(new Error("setup unreadable"));
            const result = await create();
            expect(result).toMatchObject({ status: "failed", reason: expect.stringContaining("setup unreadable") });
            expect(providers.create).not.toHaveBeenCalled();
        });

        it("still creates it, saying so, when the record can't be written; the config being there keeps the next start from creating another", async () => {
            setupState.findOne.mockResolvedValueOnce(undefined);
            setupState.create.mockRejectedValueOnce(new Error("setup readonly"));
            expect((await create()).status).toBe("created");
            expect(log.warn.mock.calls.flat().join("\n")).toContain("setup readonly");
            expect(await create()).toMatchObject({ status: "exists" });
            expect(providers.rows).toHaveLength(1);
        });
    });

    describe("says that the console changes a config that exists, never repeating a value", () => {
        const said = () => log.warn.mock.calls.flat().join("\n");

        beforeEach(async () => {
            await create();
            fs.rmSync(path.join(dir, "apiToken"));
        });

        it("is silent at a restart of a deployment installed once", async () => {
            await create();
            expect(log.warn).not.toHaveBeenCalled();
            expect(log.info).toHaveBeenCalledTimes(1);
        });

        it("warns when a re-installation names another provider, name or zones", async () => {
            for (const changed of [{ zones: ["other.example.org"] }, { name: "Another" }, { type: "route53", options: { region: "us-east-1" } }]) {
                log.warn.mockClear();
                await create({ ...CLOUDFLARE, ...changed });
                expect(said()).toContain("mail:dns:bootstrap_provider");
                expect(said()).toContain("admin console");
                expect(said()).not.toContain("other.example.org");
            }
            expect(providers.rows).toHaveLength(1);
        });

        it("warns when a re-installation brings new credentials, naming the file and never its content", async () => {
            fs.writeFileSync(path.join(dir, "apiToken"), "new-token-value");
            await create();
            expect(said()).toContain("apiToken");
            expect(said()).not.toContain("new-token-value");
            expect(said()).not.toContain("mail:dns:bootstrap_provider");
            expect(providers.rows[0].credentials.apiToken).not.toContain("new-token-value");
        });

        it("says only that it isn't created again where the administrator deleted it", async () => {
            providers.rows.length = 0;
            log.info.mockClear();
            await create();
            expect(log.info.mock.calls.flat().join("\n")).toMatch(/deleted/);
            expect(log.warn).not.toHaveBeenCalled();
        });
    });

    describe("never stops the server from starting: what can't be created is logged and the next start tries again", () => {
        const failed = async (result: Promise<any>, reason: RegExp) => {
            const outcome = await result;
            expect(outcome.status).toBe("failed");
            expect(outcome.reason).toMatch(reason);
            expect(providers.create).not.toHaveBeenCalled();
            expect(audit.record).not.toHaveBeenCalled();
            expect(publisher.changed).not.toHaveBeenCalled();
            expect(log.error.mock.calls.concat(log.warn.mock.calls).flat().join("\n")).toContain(outcome.reason);
            expect(log.error.mock.calls.concat(log.warn.mock.calls).flat().join("\n")).not.toContain(TOKEN);
        };

        it("a config the console would refuse", async () => {
            await failed(create({ ...CLOUDFLARE, zones: ["com"] }), /zone/i);
        });

        it("credentials a type needs but the Secret doesn't have", async () => {
            fs.rmSync(path.join(dir, "apiToken"));
            await failed(create(), /apiToken/);
        });

        it("credentials that can't be sealed, with no cipher or no keyring", async () => {
            await failed(create(CLOUDFLARE, { cipher: undefined }), /encryption/i);
            await failed(
                create(CLOUDFLARE, {
                    cipher: {
                        encrypt: () => {
                            throw Object.assign(new Error("No configuration keyring is loaded."), { status: 503 });
                        },
                    },
                }),
                /keyring/i,
            );
        });

        it("a name another config has, however it is capitalized", async () => {
            providers.rows.push(new Row({ uid: "console-aaaa1111", name: "INSTALLER cloudflare", nameKey: "installer cloudflare", zones: ["other.org"], origin: "console" }));
            await failed(create(), /already exists/);
        });

        it("a zone another config has, which would stall every config's publishing", async () => {
            providers.rows.push(new Row({ uid: "console-aaaa1111", name: "Mine", nameKey: "mine", zones: ["example.com"], origin: "console" }));
            await failed(create(), /example\.com/);
        });

        it("a zone that would take a domain from the config it is assigned to, whose records its instance would delete", async () => {
            providers.rows.push(new Row({ uid: "console-aaaa1111", name: "Mine", nameKey: "mine", zones: ["example.com"], origin: "console" }));
            domains.rows.push(new Row({ uid: "mail.sub.example.com", name: "mail.sub.example.com", dnsProviderUid: "console-aaaa1111" }));
            await failed(create({ ...CLOUDFLARE, zones: ["sub.example.com"] }), /mail\.sub\.example\.com/);
        });

        it("a datastore that can't be read or written, without repeating more than its message", async () => {
            providers.find.mockRejectedValueOnce(new Error("connection lost"));
            await failed(create(), /connection lost/);
            providers.create.mockRejectedValueOnce(new Error("disk full"));
            const outcome = await create();
            expect(outcome).toMatchObject({ status: "failed", reason: expect.stringContaining("disk full") });
        });
    });

    it("still creates the config when the audit entry can't be written or the controller can't be told", async () => {
        audit.record.mockRejectedValueOnce(new Error("audit down"));
        publisher.changed.mockRejectedValueOnce(new Error("redis down"));
        expect((await create()).status).toBe("created");
        expect(providers.rows).toHaveLength(1);
    });
});
