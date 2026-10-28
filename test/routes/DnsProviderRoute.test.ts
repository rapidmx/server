///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
// The server's DNS provider route marks a credential it couldn't read as unreadable in its mask (spec 10.2, "Unreadable secrets in the view"). restapi's views
// show every saved credential as a plain mask and never decrypt; the server adds the flag from what its cipher has already failed to decrypt.
import "reflect-metadata";
import { dnsCredentialContext, generateConfigKeyring, type ConfigCipher, type ConfigEnvelope } from "@rapidmx/restapi";
import { DnsProviderRoute as DnsProviderRouteMongo } from "../../src/mongo/routes/DnsProviderRoute.js";
import { DnsProviderRoute as DnsProviderRouteSql } from "../../src/sql/routes/DnsProviderRoute.js";
import { TrackedConfigCipherMongo } from "../../src/secrets/TrackedConfigCipherMongo.js";
import { TrackedConfigCipherSQL } from "../../src/secrets/TrackedConfigCipherSQL.js";
import { UnreadableSecrets } from "../../src/secrets/UnreadableSecrets.js";

/** A cipher with the keyring loaded, built as the ObjectFactory builds one but with no datastore behind it. */
async function cipherWith(cipherClass: new () => ConfigCipher, ring: object): Promise<ConfigCipher> {
    const cipher: any = new cipherClass();
    cipher.keyring = JSON.stringify(ring);
    await cipher.reload();
    return cipher;
}

const UID = "dns-cloudflare-1a2b3c4d";

function provider(credentials: Record<string, ConfigEnvelope> | null) {
    return { uid: UID, name: "Cloudflare", type: "cloudflare", zones: ["example.com"], options: {}, credentials, enabled: true, allowTakeover: false, version: 3 };
}

describe.each([
    ["mongo", DnsProviderRouteMongo, TrackedConfigCipherMongo],
    ["sql", DnsProviderRouteSql, TrackedConfigCipherSQL],
])("%s DnsProviderRoute", (_name, routeClass, cipherClass) => {
    let cipher: ConfigCipher;
    let elsewhere: ConfigCipher;

    beforeEach(async () => {
        UnreadableSecrets.reset();
        cipher = await cipherWith(cipherClass, generateConfigKeyring());
        // Another deployment's keyring: what a restore with a different keyring leaves behind.
        elsewhere = await cipherWith(cipherClass, generateConfigKeyring());
    });

    /** The route's view of `row`, with the cipher the container injects unless `injected` is false. */
    const view = (row: ReturnType<typeof provider>, injected: boolean = false) => {
        const route: any = new routeClass();
        route.cipher = injected ? cipher : undefined;
        return route.toPublic(row, 2);
    };

    it("is mounted at system/dns-providers", () => {
        expect(Reflect.getMetadata("rrst:routePaths", routeClass.prototype)).toContain("/api/system/dns-providers");
    });

    it("shows an unreadable and a readable credential side by side, once the process has tried to decrypt them", () => {
        const readable = cipher.encrypt("good-token", dnsCredentialContext(UID, "apiToken"));
        const lost = elsewhere.encrypt("lost-token", dnsCredentialContext(UID, "accountKey"));
        const row = provider({ apiToken: readable, accountKey: lost });

        // restapi's view never decrypts: before anything has tried, both are plain masks.
        expect(view(row).credentials).toEqual({ apiToken: { secret: true }, accountKey: { secret: true } });

        // What the credentials endpoint (or the re-encryption pass) does with them.
        expect(cipher.decryptString(readable, dnsCredentialContext(UID, "apiToken"))).toBe("good-token");
        expect(() => cipher.decryptString(lost, dnsCredentialContext(UID, "accountKey"))).toThrow(/can't be read/);

        const shown = view(row);
        expect(shown.credentials).toEqual({ apiToken: { secret: true }, accountKey: { secret: true, unreadable: true } });
        // The rest of the view is restapi's.
        expect(shown).toMatchObject({ uid: UID, name: "Cloudflare", type: "cloudflare", zones: ["example.com"], enabled: true, domainCount: 2, version: 3 });
        // Neither the plaintext nor an envelope is in it.
        expect(JSON.stringify(shown)).not.toMatch(/good-token|lost-token|"ct"|"iv"|"tag"/);
    });

    it("marks a credential whose key this process hasn't loaded in every copy, with nothing tried: a backup restored with an older keyring", () => {
        const readable = cipher.encrypt("good-token", dnsCredentialContext(UID, "apiToken"));
        const lost = elsewhere.encrypt("lost-token", dnsCredentialContext(UID, "accountKey"));
        const row = provider({ apiToken: readable, accountKey: lost });

        expect(view(row, true).credentials).toEqual({ apiToken: { secret: true }, accountKey: { secret: true, unreadable: true } });
        // Entering it again encrypts it with a key this copy has.
        const entered = cipher.encrypt("new-token", dnsCredentialContext(UID, "accountKey"));
        expect(view(provider({ apiToken: readable, accountKey: entered }), true).credentials).toEqual({ apiToken: { secret: true }, accountKey: { secret: true } });
    });

    it("counts a credential entered again as readable at once, with no decryption in between", () => {
        const lost = elsewhere.encrypt("lost-token", dnsCredentialContext(UID, "apiToken"));
        expect(() => cipher.decrypt(lost, dnsCredentialContext(UID, "apiToken"))).toThrow();
        expect(view(provider({ apiToken: lost })).credentials.apiToken).toEqual({ secret: true, unreadable: true });

        // The administrator enters it again: a new envelope under the same field.
        const entered = cipher.encrypt("new-token", dnsCredentialContext(UID, "apiToken"));
        expect(view(provider({ apiToken: entered })).credentials.apiToken).toEqual({ secret: true });
    });

    it("keeps one row's and one field's failure to that row and field, and forgets a credential once it decrypts", () => {
        const context = dnsCredentialContext(UID, "apiToken");
        const envelope = cipher.encrypt("token", context);
        // An envelope copied across rows or fields doesn't open, and doesn't mark this row's credential.
        expect(() => cipher.decrypt(envelope, dnsCredentialContext("dns-other", "apiToken"))).toThrow();
        expect(() => cipher.decrypt(envelope, { ...context, field: "credentials.other" })).toThrow();
        expect(view(provider({ apiToken: envelope })).credentials.apiToken).toEqual({ secret: true });

        UnreadableSecrets.record(context, envelope);
        expect(view(provider({ apiToken: envelope })).credentials.apiToken).toEqual({ secret: true, unreadable: true });
        expect(cipher.decrypt(envelope, context)).toBe("token");
        expect(view(provider({ apiToken: envelope })).credentials.apiToken).toEqual({ secret: true });
    });

    it("shows no credentials for a config that has none", () => {
        expect(view(provider(null)).credentials).toEqual({});
    });
});
