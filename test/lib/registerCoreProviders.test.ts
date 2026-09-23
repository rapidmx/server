///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
// Regression coverage for the worker.ts/worker.mongo.ts/worker.sql.ts registration-drift incidents: two separate DI
// tokens (NodeDnsResolver, then EncryptionCertificateAuthority/SigningCertificateEnrollment) were each forgotten in
// one of the three near-identical bootstrap files because the registration block had to be hand-kept-identical
// across all of them. registerCoreProviders() is the fix - one function every entry point calls - so this suite
// covers both that the function itself registers the full token set correctly, and that all three entry points
// actually call it (rather than reverting to their own inline copy, which is exactly how the drift happened before).
import * as fs from "fs";
import {
    FsDkimKeyProvider,
    LocalFsBlobStore,
    LocalX509CertificateAuthority,
    ManualSigningCertificateEnrollment,
    NodeDnsResolver,
    OpenBaoPkiCertificateAuthority,
    Rfc8823AcmeSigningCertificateEnrollment,
    S3BlobStore,
} from "@rapidmx/restapi";
import { DohDnssecDnsResolver } from "../../src/dns/DohDnssecDnsResolver.js";
import { DevBypassAvScanProvider, DevBypassSpamScanProvider } from "../../src/dev/DevScanBypass.js";
import { DevLocalDeliveryTransportMongo } from "../../src/dev/DevLocalDeliveryTransportMongo.js";
import { TieredRateLimiter } from "../../src/lib/TieredRateLimiter.js";
import { registerCoreProviders } from "../../src/lib/registerCoreProviders.js";

class FakeSearchProvider {}

function fakeConfig(values: Record<string, unknown> = {}): { get(key: string): unknown } {
    return { get: (key: string) => values[key] };
}

function recordRegistrations(config: { get(key: string): unknown }, overrides: Partial<Parameters<typeof registerCoreProviders>[2]> = {}): Record<string, any> {
    const registered: Record<string, any> = {};
    registerCoreProviders(
        { register: (clazz: any, fqn?: string) => (registered[fqn!] = clazz) },
        config,
        {
            searchProvider: FakeSearchProvider,
            devDeliveryTransport: DevLocalDeliveryTransportMongo,
            environment: "production",
            ...overrides,
        },
    );
    return registered;
}

describe("registerCoreProviders", () => {
    it("registers every DI token @rapidmx/restapi's routes/jobs pull via string-token @Inject(...)", () => {
        const registered = recordRegistrations(fakeConfig());
        expect(Object.keys(registered).sort()).toEqual(
            [
                "RateLimiter",
                "BlobStore",
                "SearchProvider",
                "SpamScanProvider",
                "AvScanProvider",
                "MailTransport",
                "DnsResolver",
                "DkimKeyProvider",
                "EncryptionCertificateAuthority",
                "SigningCertificateEnrollment",
            ].sort(),
        );
    });

    it("registers the shared, non-config-driven providers unconditionally", () => {
        const registered = recordRegistrations(fakeConfig());
        expect(registered.RateLimiter).toBe(TieredRateLimiter);
        expect(registered.SearchProvider).toBe(FakeSearchProvider);
        expect(registered.DkimKeyProvider).toBe(FsDkimKeyProvider);
    });

    it("resolves every config-driven backend to its documented default when unset", () => {
        const registered = recordRegistrations(fakeConfig());
        expect(registered.BlobStore).toBe(LocalFsBlobStore);
        expect(registered.DnsResolver).toBe(NodeDnsResolver);
        expect(registered.EncryptionCertificateAuthority).toBe(LocalX509CertificateAuthority);
        expect(registered.SigningCertificateEnrollment).toBe(ManualSigningCertificateEnrollment);
    });

    it("resolves every config-driven backend to its alternate when configured", () => {
        const registered = recordRegistrations(
            fakeConfig({
                "mail:blob:backend": "s3",
                "mail:dns:resolver": "doh-dnssec",
                "mail:pki:backend": "openbao",
                "mail:pki:signing_enrollment:backend": "rfc8823",
            }),
        );
        expect(registered.BlobStore).toBe(S3BlobStore);
        expect(registered.DnsResolver).toBe(DohDnssecDnsResolver);
        expect(registered.EncryptionCertificateAuthority).toBe(OpenBaoPkiCertificateAuthority);
        expect(registered.SigningCertificateEnrollment).toBe(Rfc8823AcmeSigningCertificateEnrollment);
    });

    it("registers the dev-bypass mail providers for a development environment, matching registerMailProviders() directly", () => {
        const registered = recordRegistrations(fakeConfig(), { environment: "development" });
        expect(registered.SpamScanProvider).toBe(DevBypassSpamScanProvider);
        expect(registered.AvScanProvider).toBe(DevBypassAvScanProvider);
        expect(registered.MailTransport).toBe(DevLocalDeliveryTransportMongo);
    });

    it("lets a caller (the Server.*.test.ts harnesses) force BlobStore/DnsResolver/SigningCertificateEnrollment regardless of config, so tests never make live S3/DoH/ACME network calls", () => {
        class ForcedBlobStore {}
        class ForcedDnsResolver {}
        class ForcedSigningCertificateEnrollment {}
        const registered = recordRegistrations(
            fakeConfig({ "mail:blob:backend": "s3", "mail:dns:resolver": "doh-dnssec", "mail:pki:signing_enrollment:backend": "rfc8823" }),
            { blobStore: ForcedBlobStore, dnsResolver: ForcedDnsResolver, signingCertificateEnrollment: ForcedSigningCertificateEnrollment },
        );
        expect(registered.BlobStore).toBe(ForcedBlobStore);
        expect(registered.DnsResolver).toBe(ForcedDnsResolver);
        expect(registered.SigningCertificateEnrollment).toBe(ForcedSigningCertificateEnrollment);
    });
});

describe("worker.ts/worker.mongo.ts/worker.sql.ts registration drift guard", () => {
    // Each of the three entry points must call the one shared function rather than its own inline
    // objectFactory.register(...) block for these tokens - reintroducing an inline copy in just one file is
    // exactly how NodeDnsResolver (commit d485c2e) and EncryptionCertificateAuthority/SigningCertificateEnrollment
    // were each silently dropped from one of the three files in the past.
    const files = ["src/worker.ts", "src/worker.mongo.ts", "src/worker.sql.ts"];

    it("imports and calls registerCoreProviders exactly once", () => {
        for (const file of files) {
            const source = fs.readFileSync(file, "utf-8");
            expect(source).toMatch(/import\s*\{\s*registerCoreProviders\s*\}\s*from\s*"\.\/lib\/registerCoreProviders\.js"/);
            // Matches only the real call site (registerCoreProviders(objectFactory, ...)), not the function name as it
            // appears in doc-comment prose elsewhere in the file.
            const calls = source.match(/registerCoreProviders\(objectFactory,/g) ?? [];
            expect(calls).toHaveLength(1);
        }
    });

    it("no longer registers DnsResolver/EncryptionCertificateAuthority/SigningCertificateEnrollment inline", () => {
        for (const file of files) {
            const source = fs.readFileSync(file, "utf-8");
            expect(source).not.toMatch(/objectFactory\.register\([^)]*,\s*"DnsResolver"\)/);
            expect(source).not.toMatch(/objectFactory\.register\([^)]*,\s*"EncryptionCertificateAuthority"\)/);
            expect(source).not.toMatch(/objectFactory\.register\([^)]*,\s*"SigningCertificateEnrollment"\)/);
        }
    });
});
