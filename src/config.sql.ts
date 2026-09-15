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
    base_path: join(_dirname, "sql"),
    cookie_secret: DEFAULT_COOKIE_SECRET,
    // See DEFAULT_MAX_BODY_SIZE_BYTES's own doc comment - the framework's own built-in default (10 MiB)
    // is too small for a real Mbox/PST mailbox-import upload.
    max_body_size: DEFAULT_MAX_BODY_SIZE_BYTES,
    cors: {
        origins: ["http://localhost:3000"],
    },
    datastores: {
        // `synchronize: true` creates and alters tables from the entities on startup - there are no migrations, so a fresh
        // install needs it, but TypeORM may drop and recreate a column whose type changed between releases (losing its
        // data). Back up before upgrading, or set `datastores__acl__synchronize`/`datastores__sql__synchronize` to false and
        // manage schema changes yourself (the Helm chart's `service.datastores.synchronize`).
        acl: {
            type: "postgres",
            host: "localhost",
            database: "rrst_acls",
            synchronize: true,
            // Required on every SQL (TypeORM) datastore per @rapidmx/restapi's README ("Required deployment
            // configuration") - several jobs query a nullable "not yet processed" marker column via a
            // literal `{ field: null }` value, which TypeORM's SelectQueryBuilder otherwise rejects outright
            // for SQL backends ("the IsNull() operator must be used").
            invalidWhereValuesBehavior: { null: "sql-null" },
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
        sql: {
            type: "postgres",
            host: "localhost",
            database: "rrst_auth",
            synchronize: true,
            // Required on every SQL (TypeORM) datastore per @rapidmx/restapi's README ("Required deployment
            // configuration") - several jobs (AttachmentExtractionJob, SearchIndexJob,
            // EasDeviceStateCleanupJob) query a nullable "not yet processed" marker column via a literal
            // `{ field: null }` value, which TypeORM's SelectQueryBuilder otherwise rejects outright for SQL
            // backends ("the IsNull() operator must be used").
            invalidWhereValuesBehavior: { null: "sql-null" },
        },
    },
    // Deployment-wide settings.
    system: {
        // Plugins (see src/plugins/PluginHost.ts). Administrators add, upgrade, configure and remove plugins in the admin
        // console; every server copy installs the enabled ones with npm at startup and restarts itself (one copy at a
        // time) when they change.
        plugins: {
            // Installed the first time a server starts against a database that has never had them. `enabled` (default
            // true) is only the initial state - administrators turn plugins on and off in the admin console after that.
            // A default an administrator later removes stays removed; a default added in a later release is still added
            // to an existing deployment.
            defaults: [
                { name: "@rapidmx/activesync-plugin", version: "latest" },
                { name: "@rapidmx/mapi-plugin", version: "latest" },
                { name: "@rapidmx/autodiscover-plugin", version: "latest" },
            ],
            // The npm registry plugins are downloaded from, and an optional auth token for a private one.
            registry: "https://registry.npmjs.org",
            registry_token: "",
            // The npm scopes the admin console searches for plugins (packages named `*-plugin`). Packages in these
            // namespaces may be added. An entry can also name its own registry and token, for a private scope:
            // { name: "@my-company", registry: "https://npm.my-company.com", token: "..." }.
            namespaces: ["@rapidmx"],
            // Other packages an administrator may add, beyond the namespaces above. Only this config can widen what's
            // allowed - a plugin runs with the server's full privileges.
            allowed_packages: ["@rapidmx/*"],
            // Where plugins are installed. Must be inside the server's directory so plugins share its packages.
            dir: join(process.cwd(), "plugins"),
            // Package name -> local .tgz (from `npm pack`) installed instead of the registry version, for developing a
            // plugin against this server. Tarballs rather than directories, so the plugin uses this server's packages.
            sources: {},
            // Whether a registry plugin needs the integrity hash the registry published when it was added. Turn off only
            // for a registry that doesn't publish integrity hashes (only legacy sha1 `shasum`s): its plugins then load
            // without their packages being verified.
            require_integrity: true,
            // How long npm may take to install plugins before it's stopped and the install counts as failed.
            npm_timeout_ms: 600_000,
            // How server copies restart to apply a plugin change (see src/plugins/PluginWatcher.ts).
            restart: {
                // How long a copy reports itself not ready (GET /api/status answers 503) before it stops, so the load
                // balancer takes it out of rotation first. Keep it above the readiness probe's period x failure threshold.
                drain_delay_ms: 15_000,
                // How long a restarted copy keeps the restart lock once it is serving, so it is ready before the next stops.
                lock_release_delay_ms: 15_000,
                // The restart lock expires this long after it was last renewed, e.g. when a copy crashes while holding it.
                lock_ttl_ms: 60_000,
                // Without a cache datastore (no restart lock), each copy waits a random time up to this before restarting.
                jitter_ms: 30_000,
                // After npm fails to install plugins (e.g. the registry is down), restart to retry after this long, doubling
                // with each failure in a row up to `install_retry_max_ms`.
                install_retry_ms: 60_000,
                install_retry_max_ms: 600_000,
                // npm failures in a row after which a copy stops restarting to retry (it keeps the plugins it already had
                // installed, and reports the failure). Errors retrying can't fix (E404, E401, EINTEGRITY...) aren't retried.
                install_retry_max_attempts: 6,
                // A copy running without plugins after repeated failed starts (safe mode) tries them again after this long,
                // doubling each time it ends up back in safe mode, up to `safe_mode_retry_max_ms`.
                safe_mode_retry_ms: 300_000,
                safe_mode_retry_max_ms: 3_600_000,
                // The most a restarted copy may take to start serving while holding the restart lock, before it lets the
                // lock expire so the other copies aren't held up by a stuck start.
                max_lock_hold_ms: 900_000,
            },
        },
    },
    class_loader: {
        ignore: [
            /server\..*/,
            /config\..*/
        ]
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
        // Tokens are only accepted from the Authorization header or the `jwt` cookie. A token in a URL query string ends up
        // in access logs, browser history and Referer headers; no client (web-client, react-shared, the plugins) sends one.
        allowQueryParam: false,
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
        // `default_quota_bytes` and `auto_provision.enabled`/`quota_bytes` seed the admin-editable mailbox policy
        // (system/mailbox-policy) the first time it's read, and stay its fallback for anything it leaves unset.
        default_quota_bytes: 5_000_000_000,
        auto_provision: {
            enabled: true,
            quota_bytes: 5_000_000_000,
            timeout_ms: 10_000
        },
        // `BaseBrandingRoute` builds a self-hosted logo/stylesheet's public URL as `${public_url}` +
        // a literal `/branding/logo`/`/branding/stylesheet`, which assumes the route is mounted at bare
        // `/branding` — but this repo mounts it under `@ApiRoute("system/branding")` (real path
        // `/api/system/branding/...`). `/api/system` is the prefix that makes the concatenation land on the
        // real mounted URL.
        branding: {
            public_url: "/api/system",
        },
        // BlobStore backend selection (see server.sql.ts) plus that backend's own config.
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
                // commit real values here - set via the mail__blob__s3__access_key_id/
                // mail__blob__s3__secret_access_key env vars.
                access_key_id: "",
                secret_access_key: "",
            },
        },
        booking: {
            // `BaseBookingRoute.manageUrl()` builds the link mailed to a booker as
            // `${public_url}/manage/${token}` — must land on `apps/book/manage/[token].tsx`, so this needs
            // the same externally-reachable base URL as `cluster_url` below, with `/book` appended (the
            // mount point of `BookRoute`). Keep the two in sync in a real deployment.
            // Empty by default: booking emails then leave out the manage link rather than pointing at a host that isn't this
            // deployment. The Helm chart sets it from its `host` value; set `mail__booking__public_url` otherwise.
            public_url: "",
        },
        compose: {
            // Caps the combined size of a draft's attachments `BaseMailComposeRoute.assemble()` will load into
            // memory at once to build MIME — see `DEFAULT_MAX_COMPOSE_ATTACHMENT_BYTES` for the fallback used
            // when this is unset.
            max_attachment_bytes: DEFAULT_MAX_COMPOSE_ATTACHMENT_BYTES,
        },
        search: {
            postgres: {
                datasource: "sql",
            },
        },
        // Defaults assume a host-run `yarn dev` process talking to docker-compose.mail.yml's standalone
        // scanning stack, whose ports are mapped straight to the host (see that file) - the same
        // localhost-reachable convention every other default in this file follows (datastores, etc). These
        // are NOT the docker-network-internal service names ("rspamd"/"clamav") that only resolve when this
        // app *also* runs inside the compose network - docker-compose.sql.yml's `server:` service already
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
        // Consumed by the registered `DkimKeyProvider` (`FsDkimKeyProvider` — see server.sql.ts). Must
        // match Postfix/rspamd's own DKIM signing path/selector exactly (docker-compose.mail.yml's
        // `dkim_rspamd_keys` volume + `DKIM_SELECTOR` env var) — these are the two ends of one shared
        // volume, not independently configurable.
        dkim: {
            key_dir: "/var/lib/rspamd/dkim",
            selector: "mail",
        },
        // The authserv-id whose Authentication-Results this server trusts to say a message's From is DKIM-verified
        // (@rapidmx/restapi's verifiedFromAddress()/hasAlignedPassingDkim(), used by ingest, ScanQueueJob, KeyringUtils
        // and ReceiptUtils). Left empty by default: fail closed, every Authentication-Results header is treated as
        // unauthenticated. Until an admin sets it to the exact authserv-id their MTA (Postfix/rspamd - see
        // docker-compose.mail.yml) stamps:
        //   - messages to a distribution list that only lets members send are all dropped (no sender is a verified member);
        //   - distribution list relay copies and mail filter forward-rule copies are sent with From rewritten to the list or
        //     the forwarding mailbox (the original sender moves to X-Original-From / Reply-To);
        //   - forwarded or list-relayed calendar invites (iTIP content) are refused;
        //   - published-key discovery via RapidMX-Key headers, read receipt verification, calendar iTIP
        //     replies/cancellations, message recalls and ACME email challenges are ignored.
        // The server logs a warning at startup while it's empty (trustedAuthservIdWarning()). Helm: mail.trustedAuthservId.
        security: {
            trusted_authserv_id: "",
        },
        // DnsResolver backend selection (see server.sql.ts) plus that backend's own config.
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
        // EncryptionCertificateAuthority backend selection (see server.sql.ts) plus that backend's own
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
                // Never commit a real token here - set via the mail__pki__openbao__token env var
                // (nconf's `__`-separated env-var convention, see conf.env({ separator: "__" }) above).
                token: "",
                timeout_ms: 5_000,
                serial_map_path: "/var/lib/rapidmx/pki/openbao-serials.json",
            },
            // SigningCertificateEnrollment backend selection (see server.sql.ts) plus that backend's
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
        // AcmeEnrollmentDriverJobSQL's own schedule/config - registered unconditionally regardless of
        // `mail:pki:signing_enrollment:backend` (see server.sql.ts's own comment on why), so this is
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
    cluster_url: "http://localhost",
    // How the server stops on SIGTERM (a container stop, a Kubernetes pod deletion): it first reports itself not ready
    // (GET /api/status answers 503) for `drain_delay_ms` so load balancers stop sending it new requests, then stops,
    // giving up and exiting after `timeout_ms`. Keep drain + timeout below the pod's terminationGracePeriodSeconds.
    shutdown: {
        drain_delay_ms: 5_000,
        timeout_ms: 25_000,
    },
    // The token this server sends telemetry events with (EventUtils, only used when `telemetry_services:url` is set).
    // It carries only these roles - never `trusted_roles` - and expires after `token_ttl_seconds`, renewed at half that.
    telemetry_services: {
        token_roles: ["telemetry"],
        token_ttl_seconds: 3_600,
    },
    metrics: {
        authRequired: true,
    },
    // Read by `TieredRateLimiter` (src/lib/TieredRateLimiter.ts, registered in place of `@rapidrest/service-core`'s
    // `RateLimiter`), which backs every `@RateLimit()`-decorated endpoint in `@rapidmx/restapi` - the three mutating
    // booking endpoints and the public key-discovery endpoint (both reachable anonymously; booking emails the booker),
    // AND `GET /mailbox/:id/keys/lookup`, which every logged-in user's compose flow calls once per new recipient.
    //
    // The top-level limits apply to ANONYMOUS requests and stay conservative - the framework's own defaults (100
    // attempts/60s per identifier, i.e. per endpoint path; 100 attempts/300s per source IP across all rate-limited
    // endpoints) - since those endpoints can be abused to send mail or enumerate keys.
    //
    // `authenticated` applies instead to requests signed in as a user, and is deliberately very high: limits for
    // signed-in users should only stop automation of large tasks, never interactive use. The identifier counter there
    // is already per user + endpoint (`@RateLimit()`'s default `perUser: true`), ~33 req/s sustained per user per
    // endpoint; the signed-in per-IP counter is separate from the anonymous one, so a shared/NAT'd office IP never
    // exhausts the anonymous budget (or the other way round), and still bounds a multi-account flood from one source.
    rateLimit: {
        enabled: true,
        // IPv6 clients are counted per network of this prefix length rather than per address - a single host is usually
        // handed a whole /64 and could otherwise rotate addresses to get a fresh budget per request. 128 counts each address.
        ipv6_prefix_length: 64,
        maxAttempts: 100,
        windowSeconds: 60,
        ip: {
            enabled: true,
            maxAttempts: 100,
            windowSeconds: 300,
        },
        authenticated: {
            maxAttempts: 10_000,
            windowSeconds: 300,
            ip: {
                enabled: true,
                maxAttempts: 20_000,
                windowSeconds: 300,
            },
        },
    },
    // IP addresses of proxies/load balancers this server sits behind and trusts to set
    // X-Forwarded-For/X-Real-IP truthfully. Left empty by default (fail closed: forwarding headers are
    // ignored and NetUtils.getIPAddress() falls back to the socket's own remote address), which is safe
    // but means per-IP rate limiting and audit-log IPs will all collapse onto the proxy's own address in
    // any deployment that actually sits behind one (the common case in production). Set this to your
    // reverse proxy/load balancer's IP(s) if you deploy behind one (the Helm chart sets it from
    // `service.trustedProxies`). Rate limiting (TieredRateLimiter) also accepts CIDR ranges here, e.g.
    // "10.0.0.0/8"; service-core's own audit-log IP lookup only matches exact addresses.
    trusted_proxies: [],
});

export default conf;
