///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { createRequire } from "module";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import nconf from "nconf";
import {
    DEFAULT_AUTH_SECRET,
    DEFAULT_COOKIE_SECRET,
    DEFAULT_GIPHY_API_KEY,
    DEFAULT_MAIL_INGEST_SECRET,
    DEFAULT_MAX_BODY_SIZE_BYTES,
    DEFAULT_MAX_COMPOSE_ATTACHMENT_BYTES,
} from "./config.defaults.js";

const _filename = fileURLToPath(import.meta.url);
const _dirname = dirname(_filename);
const _require = createRequire(import.meta.url);
const packageInfo = _require(join(process.cwd(), "package.json"));

const conf = nconf
    .argv()
    .env({
        separator: "__",
        parseValues: true,
    });

conf.use("memory");

conf.defaults({
    service_name: packageInfo.name,
    version: packageInfo.version,
    base_path: join(_dirname, "mongo"),
    cookie_secret: DEFAULT_COOKIE_SECRET,
    // See DEFAULT_MAX_BODY_SIZE_BYTES's own doc comment - the framework's own built-in default (10 MiB)
    // is too small for a real Mbox/PST mailbox-import upload.
    max_body_size: DEFAULT_MAX_BODY_SIZE_BYTES,
    cors: {
        origins: ["http://localhost:3000"],
    },
    datastores: {
        acl: {
            type: "mongodb",
            url: "mongodb://localhost:9999/acls",
            database: "rrst_acls",
            synchronize: true,
        },
        cache: {
            type: "redis",
            url: "redis://localhost",
        },
        events: {
            type: "redis",
            url: "redis://localhost"
        },
        logs: {
            type: "redis",
            url: "redis://localhost"
        },
        mongo: {
            type: "mongodb",
            host: "localhost",
            port: 9999,
            database: "rrst_auth",
            synchronize: true,
        }
    },
    // Specifies the group names that are considered to be trusted with administrative privileges.
    trusted_roles: ["admin"],
    react: {
        // Path to the Vite manifest produced by `rapidrest build`, used to resolve hashed
        // client bundle URLs for hydrated pages (see apps/www, apps/admin).
        manifestPath: "dist/public/.vite/manifest.json",
    },
    // Settings pertaining to the VERIFICATION of authentication tokens issued by the separate `auth-server`
    // deployment (see `.claude/NOTES.md`). This service never issues its own JWTs and mounts no sign-in/
    // sign-up/session routes of its own — `auth:secret` must match auth-server's own signing secret exactly.
    auth: {
        // The authentication strategy used to verify incoming JWTs.
        strategy: "auth.JWTStrategy",
        allowQueryParam: true,
        // The password used to verify authentication tokens. Must match auth-server's own `auth:secret`.
        secret: DEFAULT_AUTH_SECRET,
        // Lets `apps/www`/`apps/admin`'s SSR pages read `req.user` from the `jwt` cookie auth-server sets,
        // without the browser having to attach an Authorization header itself. auth-server and mail-server
        // must be deployed under a shared cookie domain (a Helm-chart-level concern, not configured here)
        // for this to actually work across the two services.
        cookie: {
            enabled: true,
            access: { name: "jwt" },
        },
        options: {
            audience: "mydomain.com",
            issuer: "api.mydomain.com",
        },
    },
    // The externally-deployed auth-server's base URL — the webmail/admin frontends redirect an
    // unauthenticated visitor here to sign in, then back with a valid session.
    mail: {
        auth_server_url: "http://localhost:3001",
        auto_provision: {
            enabled: true,
            quota_bytes: 5_000_000_000,
            timeout_ms: 10_000
        },
        // `BaseBrandingRoute` builds a self-hosted logo/stylesheet's public URL as `${public_url}` +
        // a literal `/branding/logo`/`/branding/stylesheet`, which assumes the route is mounted at bare
        // `/branding` — but this repo mounts it under `@ApiRoute("mail/branding")` (real path
        // `/api/mail/branding/...`). `/api/mail` is the prefix that makes the concatenation land on the
        // real mounted URL.
        branding: {
            public_url: "/api/mail",
        },
        // BlobStore backend selection (see server.mongo.ts) plus that backend's own config.
        // `backend: "local"` (default) needs only `local.root` below; `backend: "s3"` needs `s3.*`
        // instead and a real S3-compatible bucket (AWS S3, MinIO, R2, Spaces, ...).
        blob: {
            backend: "local",
            local: {
                // Local filesystem root for raw MIME sources, sanitized HTML, attachment binaries, extracted
                // attachment text, and contact photos (see `LocalFsBlobStore`). Must be a persistent volume
                // in any real deployment.
                root: "./data/blobs",
            },
            s3: {
                bucket: "",
                region: "",
                // Key prefix for sharing one bucket across environments/deployments - trailing "/" is
                // stripped by S3BlobStore itself.
                prefix: "",
                // Non-empty only for an S3-compatible provider that isn't real AWS S3 (MinIO, R2, Spaces).
                endpoint: "",
                // MinIO and most self-hosted S3-compatible servers need path-style requests; real AWS S3
                // does not. Leave false for AWS.
                force_path_style: false,
                // Both empty by default, falling back to the standard AWS credential chain (IAM role) -
                // the same posture SesMailTransport already uses. Set both (never just one -
                // S3BlobStore throws if only one is set) to use a static access key pair instead. Never
                // commit real values here - set via RAPIDMX_MAIL__BLOB__S3__ACCESS_KEY_ID/
                // RAPIDMX_MAIL__BLOB__S3__SECRET_ACCESS_KEY env vars.
                access_key_id: "",
                secret_access_key: "",
            },
        },
        booking: {
            // `BaseBookingRoute.manageUrl()` builds the link mailed to a booker as
            // `${public_url}/manage/${token}` — must land on `apps/book/manage/[token].tsx`, so this needs
            // the same externally-reachable base URL as `cluster_url` below, with `/book` appended (the
            // mount point of `BookRoute`). Keep the two in sync in a real deployment.
            public_url: "http://localhost/book",
        },
        compose: {
            // Caps the combined size of a draft's attachments `BaseMailComposeRoute.assemble()` will load into
            // memory at once to build MIME — see `DEFAULT_MAX_COMPOSE_ATTACHMENT_BYTES` for the fallback used
            // when this is unset.
            max_attachment_bytes: DEFAULT_MAX_COMPOSE_ATTACHMENT_BYTES,
        },
        search: {
            mongo: {
                datasource: "mongo",
            },
        },
        // Defaults assume a host-run `yarn dev` process talking to docker-compose.mail.yml's standalone
        // scanning stack, whose ports are mapped straight to the host (see that file) - the same
        // localhost-reachable convention every other default in this file follows (datastores, etc). These
        // are NOT the docker-network-internal service names ("rspamd"/"clamav") that only resolve when this
        // app *also* runs inside the compose network - docker-compose.mongo.yml's `server:` service already
        // overrides both via env vars for that case. Left as the bare service names here previously, which
        // broke plain `yarn dev` with `getaddrinfo ENOTFOUND clamav`/`rspamd` the moment mail send tried to
        // scan anything (ScanPipeline fails closed on a scan-engine outage - see ScanPipeline.ts - so this
        // didn't just log a warning, it silently quarantined every outbound message instead of relaying it).
        scan: {
            spam: {
                rspamd: {
                    url: "http://localhost:11333",
                },
            },
            av: {
                clamav: {
                    host: "127.0.0.1",
                    port: 3310,
                },
            },
        },
        transport: {
            // The internal MTA (Postfix) hand-off contract's bearer secret (see `BaseMailIngestRoute`,
            // mounted at `/internal/mta`). Must match whatever secret Postfix's content-filter/recipient-
            // validation hooks are configured to send.
            ingest: {
                secret: DEFAULT_MAIL_INGEST_SECRET,
            },
        },
        // Consumed by the registered `DkimKeyProvider` (`FsDkimKeyProvider` — see server.mongo.ts). Must
        // match Postfix/rspamd's own DKIM signing path/selector exactly (docker-compose.mail.yml's
        // `dkim_rspamd_keys` volume + `DKIM_SELECTOR` env var) — these are the two ends of one shared
        // volume, not independently configurable.
        dkim: {
            key_dir: "/var/lib/rspamd/dkim",
            selector: "mail",
        },
        // Consumed by RapidMX-Key header / MDN receipt processing (KeyringUtils, ReceiptUtils in
        // @rapidmx/restapi) to decide which Authentication-Results the upstream MTA/DKIM-verifier can be
        // trusted to have stamped. Left empty by default (fail closed - per @rapidmx/restapi's own design,
        // an unset trusted_authserv_id means every Authentication-Results header is treated as
        // unauthenticated, so RapidMX-Key/receipt trust checks pass nothing at all). An admin MUST set this
        // to the exact authserv-id string their MTA (Postfix/rspamd - see docker-compose.mail.yml) stamps
        // before enabling E2E encryption or receipt verification in production.
        security: {
            trusted_authserv_id: "",
        },
        // DnsResolver backend selection (see server.mongo.ts) plus that backend's own config.
        // `resolver: "node"` (default) uses Node's own built-in resolver, with no DNSSEC validation.
        // `resolver: "doh-dnssec"` validates DNSSEC on every lookup via a trusted upstream DoH resolver
        // instead, per specs/end-to-end_encryption.md's Transport Trust requirement - see
        // DohDnssecDnsResolver.ts's own doc comment for why this needs an external validating resolver
        // rather than something Node's built-in `dns` module can do on its own.
        dns: {
            resolver: "node",
            doh: {
                endpoint: "https://cloudflare-dns.com/dns-query",
                // Fail closed by default (mirrors mail:security:trusted_authserv_id's own empty-default
                // fail-closed convention above): a domain that fails DNSSEC validation, or isn't signed at
                // all, is treated as a lookup failure. Set to false to downgrade to "validate when
                // possible" for interoperability with unsigned zones - an explicit, informed admin choice.
                require_ad: true,
                timeout_ms: 5_000,
            },
        },
        // EncryptionCertificateAuthority backend selection (see server.mongo.ts) plus that backend's own
        // config. `backend: "local"` (default) needs only `local_ca.*` below; `backend: "openbao"` needs
        // `openbao.*` instead and a running OpenBao/Vault PKI mount (not started by this repo's
        // docker-compose by default - see docker-compose.openbao.yml.example).
        pki: {
            backend: "local",
            local_ca: {
                dir: "/var/lib/rapidmx/pki",
                subject: "CN=RapidMX Local Encryption CA",
                validity_days: 397,
            },
            openbao: {
                address: "http://127.0.0.1:8200",
                mount: "pki",
                role: "rapidmx",
                // Never commit a real token here - set via the RAPIDMX_MAIL__PKI__OPENBAO__TOKEN env var
                // (nconf's `__`-separated env-var convention, see conf.env({ separator: "__" }) above).
                token: "",
                timeout_ms: 5_000,
                serial_map_path: "/var/lib/rapidmx/pki/openbao-serials.json",
            },
            // SigningCertificateEnrollment backend selection (see server.mongo.ts) plus that backend's
            // own config. `signing_enrollment.backend: "manual"` (default) needs only
            // `manual_enrollment.*` below; `"rfc8823"` needs `rfc8823.*` instead.
            signing_enrollment: {
                backend: "manual",
            },
            // ManualSigningCertificateEnrollment's on-disk store of in-flight CSR enrollments awaiting a
            // human to paste the CA-issued certificate back in.
            manual_enrollment: {
                store_path: "/var/lib/rapidmx/pki/manual-enrollments.json",
            },
            // Rfc8823AcmeSigningCertificateEnrollment's config - real RFC 8823 email-reply-00 ACME
            // automation. `directory_url` defaults to a public ACME CA that supports this challenge
            // type; `contact_email` is optional (sent to the CA, not this deployment's own mailboxes);
            // `store_dir` persists the one ACME account key/URL for the whole deployment plus
            // per-enrollment state, mirroring `local_ca.dir`'s own disk-persistence pattern.
            rfc8823: {
                directory_url: "https://acme.castle.cloud/acme/directory",
                contact_email: "",
                store_dir: "/var/lib/rapidmx/pki/rfc8823",
            },
        },
        // AcmeEnrollmentDriverJobMongo's own schedule/config - registered unconditionally regardless of
        // `mail:pki:signing_enrollment:backend` (see server.mongo.ts's own comment on why), so this is
        // harmless to leave at its default even when RFC 8823 automation isn't enabled.
        jobs: {
            acme_enrollment_driver: {
                // Every 5 minutes, cron syntax (seconds field included).
                schedule: "0 */5 * * * *",
                expiry_warning_days: 30,
            },
        },
    },
    giphy: {
        api_key: DEFAULT_GIPHY_API_KEY,
    },
    class_loader: {
        ignore: [
            /server\..*/,
            /config\..*/
        ]
    },
    cluster_url: "http://localhost",
    metrics: {
        authRequired: true,
    },
    // Read by `RateLimiter` (see `@rapidrest/service-core`), which backs every `@RateLimit()`-decorated
    // endpoint in `@rapidmx/restapi` - the three mutating booking endpoints, the public key-discovery
    // endpoint, AND `GET /mailbox/:id/keys/lookup`, which every logged-in user's compose flow calls once
    // per new recipient. The framework's own built-in default (100 attempts/60s per identifier, 100
    // attempts/300s per source IP - see `RateLimiter`'s class default) is tuned for brute-force-prone
    // anonymous endpoints and is far too tight for that key-lookup route: an ordinary logged-in user
    // moving around the app and composing to a handful of new contacts in one session can trip 429s on
    // legitimate traffic, and because the per-IP counter is shared across every rate-limited endpoint
    // (not just the one being called), that trips even faster for anyone behind a shared/NAT'd IP.
    // Raised well past `@rapidmx/restapi`'s own test-suite headroom (1000/300, 5000/300 - see
    // `test/config-defaults.ts`) a second time after that still proved too tight for real interactive
    // use: the identifier layer is already scoped per logged-in user + endpoint (`@RateLimit()`'s default
    // `perUser: true`), so there is little downside to making it very permissive - ~33 req/s sustained per
    // user per endpoint is far beyond anything a human clicking around could produce, but a scripted flood
    // sustained past that still exhausts the window and gets 429'd. The per-IP layer is raised
    // proportionally, since it's the one most likely to trip first for anyone testing from a single
    // machine (dev, or a shared/NAT'd office IP) - it still bounds a genuine multi-account flood from one
    // source, just at a much higher ceiling.
    rateLimit: {
        enabled: true,
        maxAttempts: 10_000,
        windowSeconds: 300,
        ip: {
            enabled: true,
            maxAttempts: 20_000,
            windowSeconds: 300,
        },
    },
    // Exact IP addresses of proxies/load balancers this server sits behind and trusts to set
    // X-Forwarded-For/X-Real-IP truthfully. Left empty by default (fail closed: forwarding headers are
    // ignored and NetUtils.getIPAddress() falls back to the socket's own remote address), which is safe
    // but means per-IP rate limiting and audit-log IPs will all collapse onto the proxy's own address in
    // any deployment that actually sits behind one (the common case in production). Set this to your
    // reverse proxy/load balancer's IP(s) if you deploy behind one.
    trusted_proxies: [],
});

export default conf;
