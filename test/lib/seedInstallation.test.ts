///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
// What a server does for the installation it was installed for, once its datastores are connected and before it reports ready (restapi spec 12.1, 13.3):
// the installer's DNS provider config first, so a seeded domain can be assigned to it, then the domains of `mail:domains`.
import fs from "fs";
import os from "os";
import path from "path";
import { AuditLogUtils, type ConfigCipher } from "@rapidmx/restapi";
import { RepoUtils } from "@rapidrest/service-core";
import { seedInstallation } from "../../src/lib/seedInstallation.js";
import { keyringCipher, layeredConfig, logger } from "../helpers/integrations.js";

const ZONE_ID = "0123456789abcdef0123456789abcdef";
const CLOUDFLARE = { name: "Installer Cloudflare", type: "cloudflare", zones: ["example.com"], options: { zoneIds: [ZONE_ID] } };

class DnsProviderDouble {
    constructor(fields: Record<string, any>) {
        Object.assign(this, fields);
    }
}
class DomainDouble {}
class SetupStateDouble {}
class AuditLogDouble {}

describe("seedInstallation", () => {
    let dir: string;
    let cipher: ConfigCipher;
    let rows: Record<string, any[]>;
    let events: string[];
    let seeder: { run: ReturnType<typeof vi.fn>; domains?: unknown };
    let publisher: { changed: ReturnType<typeof vi.fn> };
    let factory: { newInstance: ReturnType<typeof vi.fn> };
    let log: ReturnType<typeof logger>;
    let conf: ReturnType<typeof layeredConfig>;
    class DomainSeederDouble {
        public domains: unknown = undefined;
    }

    const classes = () => ({ dnsProviderClass: DnsProviderDouble, domainClass: DomainDouble, setupStateClass: SetupStateDouble, auditLogClass: AuditLogDouble, domainSeederClass: DomainSeederDouble });

    beforeEach(async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "dns-bootstrap-"));
        fs.writeFileSync(path.join(dir, "apiToken"), "cf-secret-token-0123456789\n");
        conf = layeredConfig({ mail: { dns: { bootstrap_provider: JSON.stringify(CLOUDFLARE), bootstrap_credentials_dir: dir } } });
        ({ cipher } = await keyringCipher(conf));
        rows = {};
        events = [];
        log = logger();
        publisher = { changed: vi.fn(async () => undefined) };
        seeder = {
            run: vi.fn(async () => {
                events.push(`seeder (installer providers: ${(rows.DnsProviderDouble ?? []).filter((row) => row.origin === "installer").length})`);
                return { created: ["example.com"], recorded: [], skipped: 0, adopted: [] };
            }),
        };
        factory = {
            newInstance: vi.fn(async (type: any, options: any = {}) => {
                if (type === RepoUtils) {
                    const name: string = options.args[0].name;
                    rows[name] ??= [];
                    return {
                        findOne: async (uid: string) => rows[name].find((row) => row.uid === uid),
                        update: async (patch: any, existing: any) => Object.assign(existing, patch),
                        find: async (query: Record<string, any>) => {
                            const { sort: _sort, limit: _limit, page, ...match } = query;
                            return page ? [] : rows[name].filter((row) => Object.entries(match).every(([key, value]) => row[key] === value));
                        },
                        create: async (entity: any) => {
                            events.push(`create ${name}`);
                            rows[name].push(entity);
                            return entity;
                        },
                    };
                }
                if (type === AuditLogUtils) {
                    return { record: async () => undefined };
                }
                if (type === "ConfigCipher") {
                    return cipher;
                }
                if (type === "DnsPublisher") {
                    return publisher;
                }
                if (type === DomainSeederDouble) {
                    seeder.domains = conf.get("mail:domains");
                    return seeder;
                }
                throw new Error(`unexpected ${String(type?.name ?? type)}`);
            }),
        };
    });
    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it("creates the installer's provider config first, then seeds the domains, so a seeded domain can be assigned to it", async () => {
        const result = await seedInstallation(factory, conf, log, classes());
        expect(events).toEqual(["create DnsProviderDouble", "create SetupStateDouble", "seeder (installer providers: 1)"]);
        expect(result.dnsProvider.status).toBe("created");
        expect(result.domains).toEqual({ created: ["example.com"], recorded: [], skipped: 0, adopted: [] });
        expect(rows.DnsProviderDouble[0]).toMatchObject({ origin: "installer", name: "Installer Cloudflare" });
        expect(publisher.changed).toHaveBeenCalledWith({ scope: "provider", providerUid: rows.DnsProviderDouble[0].uid });
    });

    it("reads the credentials from the directory mail:dns:bootstrap_credentials_dir names", async () => {
        await seedInstallation(factory, conf, log, classes());
        expect(Object.keys(rows.DnsProviderDouble[0].credentials)).toEqual(["apiToken"]);
    });

    it("seeds the domains on a deployment installed without a provider, creating no config", async () => {
        conf.set("mail:dns:bootstrap_provider", "");
        const result = await seedInstallation(factory, conf, log, classes());
        expect(result.dnsProvider).toEqual({ status: "none" });
        expect(events).toEqual(["seeder (installer providers: 0)"]);
        expect(rows.DnsProviderDouble ?? []).toEqual([]);
    });

    it("seeds the domains of a deployment whose provider config can't be created; they are created manual", async () => {
        fs.rmSync(path.join(dir, "apiToken"));
        const result = await seedInstallation(factory, conf, log, classes());
        expect(result.dnsProvider.status).toBe("failed");
        expect(events).toEqual(["seeder (installer providers: 0)"]);
        expect(result.domains).toBeDefined();
    });

    describe("a domain that names the installer's provider when it could not be created", () => {
        const LISTED = ["example.com", { name: "shop.example.com", dnsProvider: "bootstrap" }, { name: "other.org", dnsProvider: "bootstrap" }, { name: "plain.org", dmarcPolicy: "none" }];
        const seeded = () => (seeder.domains as any[]).map((entry) => (typeof entry === "string" ? entry : entry.name));

        beforeEach(() => {
            conf.set("mail:domains", LISTED);
        });

        it("is held back, so that it isn't created manual and recorded as seeded for good, and the others are seeded", async () => {
            fs.rmSync(path.join(dir, "apiToken"));
            const result = await seedInstallation(factory, conf, log, classes());
            expect(result.dnsProvider.status).toBe("failed");
            expect(seeded()).toEqual(["example.com", "plain.org"]);
            // An entry keeps its options.
            expect((seeder.domains as any[])[1]).toEqual({ name: "plain.org", dmarcPolicy: "none" });
            const said = log.warn.mock.calls.flat().join("\n");
            expect(said).toContain("shop.example.com, other.org");
            expect(said).toMatch(/restart/);
        });

        it("is seeded with the config at the first start that has it", async () => {
            fs.rmSync(path.join(dir, "apiToken"));
            await seedInstallation(factory, conf, log, classes());
            fs.writeFileSync(path.join(dir, "apiToken"), "cf-secret-token-0123456789\n");
            await seedInstallation(factory, conf, log, classes());
            expect(seeded()).toEqual(["example.com", "shop.example.com", "other.org", "plain.org"]);
        });

        it("is left to the seeder where the config was created, or was never asked for", async () => {
            await seedInstallation(factory, conf, log, classes());
            expect(seeder.domains).toBe(LISTED);
            conf.set("mail:dns:bootstrap_provider", "");
            await seedInstallation(factory, conf, log, classes());
            expect(seeder.domains).toBe(LISTED);
        });

        it("changes nothing where no listed domain names it, so the seeder reports its own problems", async () => {
            fs.rmSync(path.join(dir, "apiToken"));
            conf.set("mail:domains", ["example.com", { name: "x.org", bogus: true }]);
            const listed = conf.get("mail:domains");
            await seedInstallation(factory, conf, log, classes());
            expect(seeder.domains).toEqual(listed);
        });

        it("reports the entries it can't read itself, since the list the seeder is left with has none", async () => {
            fs.rmSync(path.join(dir, "apiToken"));
            conf.set("mail:domains", [{ name: "shop.example.com", dnsProvider: "bootstrap" }, { name: "x.org", bogus: true }]);
            await seedInstallation(factory, conf, log, classes());
            expect(seeded()).toEqual([]);
            expect(log.warn.mock.calls.flat().join("\n")).toContain("bogus");
        });
    });

    it("is idempotent: the second start creates nothing again and seeds nothing new", async () => {
        await seedInstallation(factory, conf, log, classes());
        seeder.run.mockResolvedValueOnce({ created: [], recorded: ["example.com"], skipped: 0, adopted: [] });
        const second = await seedInstallation(factory, conf, log, classes());
        expect(second.dnsProvider.status).toBe("exists");
        expect(rows.DnsProviderDouble).toHaveLength(1);
    });

    it("says what it did, once, and nothing when there was nothing to do", async () => {
        await seedInstallation(factory, conf, log, classes());
        const said: string = log.info.mock.calls.flat().join("\n");
        expect(said).toContain("Installer Cloudflare");
        expect(said).toContain("example.com");
        expect(said).not.toContain("cf-secret-token");

        log = logger();
        seeder.run.mockResolvedValueOnce({ created: [], recorded: [], skipped: 0, adopted: [] });
        await seedInstallation(factory, conf, log, classes());
        expect(log.info).not.toHaveBeenCalled();
    });

    it("warns about the entries the seeder skipped", async () => {
        seeder.run.mockResolvedValueOnce({ created: [], recorded: [], skipped: 2, adopted: [] });
        await seedInstallation(factory, conf, log, classes());
        expect(log.warn.mock.calls.flat().join("\n")).toMatch(/2 .*skipped/);
    });

    it("never throws: a seeder that does, a seeder that can't be built and a datastore that can't be reached are logged", async () => {
        seeder.run.mockRejectedValueOnce(new Error("domains unreadable"));
        await expect(seedInstallation(factory, conf, log, classes())).resolves.toMatchObject({ dnsProvider: { status: "created" } });
        expect(log.error.mock.calls.flat().join("\n")).toContain("domains unreadable");

        log = logger();
        factory.newInstance.mockImplementation(async () => {
            throw new Error("No class found with name: DomainSeederDouble");
        });
        const result = await seedInstallation(factory, conf, log, classes());
        expect(result.dnsProvider.status).toBe("failed");
        expect(result.domains).toBeUndefined();
        expect(log.error).toHaveBeenCalled();
    });

    it("runs without a cipher or a DNS publisher registered: the config is created without credentials only if it needs none, and the controller is told at its resync", async () => {
        const original = factory.newInstance.getMockImplementation()!;
        factory.newInstance.mockImplementation(async (type: any, options: any) => {
            if (type === "ConfigCipher" || type === "DnsPublisher") {
                throw new Error(`No class found with name: ${type}`);
            }
            return original(type, options);
        });
        const result = await seedInstallation(factory, conf, log, classes());
        // Cloudflare needs its token, which can't be sealed without a cipher.
        expect(result.dnsProvider.status).toBe("failed");
        expect(result.domains).toBeDefined();

        conf.set("mail:dns:bootstrap_provider", JSON.stringify({ name: "Aws", type: "route53", zones: ["example.com"], options: { region: "us-east-1" } }));
        expect((await seedInstallation(factory, conf, log, classes())).dnsProvider.status).toBe("created");
    });
});
