///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
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
import { DohDnssecDnsResolver } from "../dns/DohDnssecDnsResolver.js";
import type { DevLocalDeliveryTransport } from "../dev/DevLocalDeliveryTransport.js";
import { registerMailProviders, type ClassRegistry } from "../dev/registerMailProviders.js";
import { selectConfigDrivenBackend } from "./configDrivenBackend.js";
import { TieredRateLimiter } from "./TieredRateLimiter.js";

/** The part of `nconf` this needs. */
export interface CoreProvidersConfig {
    get(key: string): unknown;
}

export interface RegisterCoreProvidersOptions {
    /** `MongoTextSearchProvider`/`PostgresFullTextSearchProvider` - the one thing that isn't config-driven, since the
     * search backend follows the datastore each entry point is already wired to, not a separate setting. */
    searchProvider: any;
    /** The datastore's `DevLocalDeliveryTransport` subclass, passed through to `registerMailProviders()` and used
     * only under a development `NODE_ENV`. */
    devDeliveryTransport: new () => DevLocalDeliveryTransport;
    /** The raw `NODE_ENV`, passed through to `registerMailProviders()`. Required (not read from `process.env`
     * internally) so a caller that needs deterministic, non-dev registrations regardless of the process's actual
     * `NODE_ENV` - see `Server.mongo.test.ts`/`Server.sql.test.ts`, which must never make live network calls against
     * rspamd/ClamAV/a real MTA - can pin it explicitly. */
    environment: string | undefined;
    /**
     * Forces `BlobStore` to this implementation instead of the config-driven `mail:blob:backend` selection
     * (`LocalFsBlobStore`/`S3BlobStore`). Used by the `Server.*.test.ts` harnesses, which must never make live S3
     * calls, regardless of what a test's config happens to set.
     */
    blobStore?: any;
    /**
     * Forces `DnsResolver` to this implementation instead of the config-driven `mail:dns:resolver` selection
     * (`NodeDnsResolver`/`DohDnssecDnsResolver`). Used by the `Server.*.test.ts` harnesses, which must never make
     * live DoH network calls.
     */
    dnsResolver?: any;
    /**
     * Forces `SigningCertificateEnrollment` to this implementation instead of the config-driven
     * `mail:pki:signing_enrollment:backend` selection (`ManualSigningCertificateEnrollment`/
     * `Rfc8823AcmeSigningCertificateEnrollment`). Used by the `Server.*.test.ts` harnesses, which must never make
     * live ACME network calls.
     */
    signingCertificateEnrollment?: any;
}

/**
 * Registers every DI-token/provider `@rapidmx/restapi`'s own routes/jobs pull via string-token `@Inject(...)` - there
 * is no config-driven auto-wiring for these, so a route/job touching a token nothing has registered fails to
 * construct at all (`No class found with name: ...`).
 *
 * Extracted out of `worker.ts`/`worker.mongo.ts`/`worker.sql.ts`'s own near-identical inline registration blocks,
 * which had to be hand-kept-identical across all three entry points and drifted out of sync twice in practice: once
 * missing `NodeDnsResolver` from `worker.mongo.ts`/`worker.sql.ts` (commit `d485c2e`), and once missing
 * `EncryptionCertificateAuthority`/`SigningCertificateEnrollment` from `worker.ts` entirely (see that file's own git
 * history) after a later batch added them to the other two files only. Calling this one function identically from
 * every entry point - including the `Server.*.test.ts` harnesses, which build their own `Server`/`ObjectFactory`
 * rather than importing `worker.mongo.ts`/`worker.sql.ts` (both run `void start(...)` unconditionally at module load
 * with no "only if this is the main module" guard - see `selectConfigDrivenBackend()`'s own doc comment) - means a
 * newly-introduced token only ever needs to be added in one place.
 *
 * @param objectFactory The server's `ObjectFactory` (or a test double satisfying `ClassRegistry`).
 * @param config The loaded runtime configuration, read for every config-driven backend selection below.
 * @param options Per-entry-point pieces that aren't shared (the search provider and dev delivery transport), plus
 * the deterministic overrides the test harnesses use to avoid live network calls.
 */
export function registerCoreProviders(objectFactory: ClassRegistry, config: CoreProvidersConfig, options: RegisterCoreProvidersOptions): void {
    // Separate anonymous and signed-in rate limits (config `rateLimit` and `rateLimit.authenticated`) - see TieredRateLimiter.ts.
    objectFactory.register(TieredRateLimiter, "RateLimiter");

    // BlobStore backend is config-driven (mail:blob:backend) rather than hardcoded, same pattern as
    // mail:pki:backend below: "local" (default) needs only mail:blob:local:root; "s3" delegates to an
    // S3-compatible bucket (mail:blob:s3:*) for production use.
    objectFactory.register(
        options.blobStore ?? selectConfigDrivenBackend(config, "mail:blob:backend", "s3", LocalFsBlobStore, S3BlobStore),
        "BlobStore",
    );
    objectFactory.register(options.searchProvider, "SearchProvider");
    // SpamScanProvider/AvScanProvider/MailTransport: rspamd, ClamAV and Postfix. Under a development NODE_ENV only, wrapped so
    // `yarn dev` can send mail without them running - see dev/registerMailProviders.ts. Any other NODE_ENV fails closed.
    registerMailProviders(objectFactory, options.devDeliveryTransport, options.environment, config);
    // DnsResolver backend is config-driven (mail:dns:resolver) rather than hardcoded, same rationale as
    // mail:pki:backend below: "node" (default) is Node's own built-in resolver with no DNSSEC validation,
    // "doh-dnssec" validates DNSSEC (specs/end-to-end_encryption.md's Transport Trust requirement) via a
    // trusted upstream DoH resolver (mail:dns:doh:*) instead - see DohDnssecDnsResolver.ts's own doc comment
    // for why Node's built-in resolver can't do this itself.
    const dnsResolverBackend: string = (config.get("mail:dns:resolver") as string) || "node";
    objectFactory.register(options.dnsResolver ?? (dnsResolverBackend === "doh-dnssec" ? DohDnssecDnsResolver : NodeDnsResolver), "DnsResolver");
    // Opts into automatic per-domain DKIM key generation (writing into the shared volume the Postfix/rspamd
    // container reads from - see docker-compose.mail.yml's `dkim_rspamd_keys` volume and `mail:dkim:*`
    // config) rather than the library's default manual model (`NullDkimKeyProvider`, an admin fills in
    // dkimSelector/dkimPublicKey by hand). See @rapidmx/restapi's dkim/DkimKeyProvider.ts doc comment for the
    // security tradeoff this represents before changing it back.
    objectFactory.register(FsDkimKeyProvider, "DkimKeyProvider");
    // EncryptionCertificateAuthority backend is config-driven (mail:pki:backend) rather than hardcoded like
    // every provider above, since an admin needs to pick this per-deployment without a code change: "local"
    // (default) is zero-infra (LocalX509CertificateAuthority persists its CA key/cert to mail:pki:local_ca:dir),
    // "openbao" delegates to a self-hosted OpenBao/Vault PKI mount (mail:pki:openbao:*) for production use.
    const caBackend: string = (config.get("mail:pki:backend") as string) || "local";
    objectFactory.register(caBackend === "openbao" ? OpenBaoPkiCertificateAuthority : LocalX509CertificateAuthority, "EncryptionCertificateAuthority");
    // SigningCertificateEnrollment backend is config-driven (mail:pki:signing_enrollment:backend) rather
    // than hardcoded, same pattern as mail:pki:backend above: "manual" (default) is the CA-agnostic,
    // human-in-the-loop flow (mail:pki:manual_enrollment:store_path); "rfc8823" automates public-CA
    // enrollment end to end via RFC 8823 email-reply-00 ACME (mail:pki:rfc8823:*).
    objectFactory.register(
        options.signingCertificateEnrollment ??
            selectConfigDrivenBackend(
                config,
                "mail:pki:signing_enrollment:backend",
                "rfc8823",
                ManualSigningCertificateEnrollment,
                Rfc8823AcmeSigningCertificateEnrollment,
            ),
        "SigningCertificateEnrollment",
    );
}
