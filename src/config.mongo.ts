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
    DEFAULT_APPEARANCE_BACKGROUND_MAX_BYTES,
    DEFAULT_MAX_COMPOSE_ATTACHMENT_BYTES,
    INTEGRATIONS_STORE,
    PLUGIN_SETTINGS_STORE,
    ensurePushDatastore,
} from "./config.defaults.js";

const _filename = fileURLToPath(import.meta.url);
const _dirname = dirname(_filename);
const _require = createRequire(import.meta.url);
const packageInfo = _require(join(process.cwd(), "package.json"));

// The first layer, so the settings saved on plugins in the admin console win over the environment (config.defaults.ts). The second is what an administrator
// set in the console's Integrations, which also wins over the environment until it is reset (src/integrations/IntegrationsLayer.ts).
const conf = nconf
    .add(PLUGIN_SETTINGS_STORE, { type: "literal", store: {} })
    .add(INTEGRATIONS_STORE, { type: "literal", store: {} })
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
        // No `url`/`port` here: a default `url` would win over the host/database/credentials a deployment sets (the Helm
        // chart sets those, not a url), and a non-standard port would be appended to its host. `yarn dev` and the tests
        // set `datastores__*__url` themselves.
        //
        // `synchronize: true` creates and updates collections/indexes from the models on startup - there are no migrations,
        // so a fresh install needs it. Set `datastores__acl__synchronize`/`datastores__mongo__synchronize` to false to
        // manage schema changes yourself (the Helm chart's `service.datastores.synchronize`).
        acl: {
            type: "mongodb",
            host: "localhost",
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
            database: "rrst_auth",
            synchronize: true,
        }
    },
    // Specifies the group names that are considered to be trusted with administrative privileges.
    trusted_roles: ["admin"],
    react: {
        // Path to the Vite manifest produced by `rapidrest build`, used to resolve hashed
        // client bundle URLs for hydrated pages (see apps/www, apps/admin). When enabled plugins ship UI, the server
        // replaces this at startup with the build it makes in system:plugins:dir/.ui-build (see src/plugins/PluginUiBuilder.ts).
        manifestPath: "dist/public/.vite/manifest.json",
    },
    // The browser build's static files (`/assets`, `/fonts`, `/images`, `/styles`), served by src/routes/BaseStaticAssetRoute.ts
    // with ETag/304, Cache-Control (fingerprinted bundles are cached for a year, marked immutable) and brotli/gzip.
    static_assets: {
        // Send `Content-Encoding` variants: the `.br`/`.gz` files `yarn build` writes next to each bundle, or ones made on the
        // first request and kept in memory. Turn off only if a proxy in front must see the bytes uncompressed.
        compress: true,
        // The most memory the cache of file contents and compressed variants may hold, in bytes.
        memory_cache_bytes: 64 * 1024 * 1024,
        // Brotli quality (0-11) of variants made on the fly, i.e. for files with no `.br` sibling (a plugin UI build gets its own).
        brotli_quality: 9,
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
    // Admin console > Diagnostics (routes/BaseDiagnosticsRoute.ts). Kubernetes is asked with the pod's own service account, which
    // the Helm chart grants read access to in its own namespace only (global.diagnostics.rbac.create); outside a cluster, or without
    // it, those parts report they are unavailable.
    diagnostics: {
        // The namespace to inspect. Empty is the pod's own.
        namespace: "",
        // How long one Kubernetes API request may take before that part reports an error.
        timeout_ms: 5000,
    },
    // The externally-deployed auth-server's base URL — the webmail/admin frontends redirect an
    // unauthenticated visitor here to sign in, then back with a valid session.
    mail: {
        auth_server_url: "http://localhost:3001",
        // Outlook (MAPI/HTTP) and Exchange ActiveSync clients can only send HTTP Basic credentials, so on `paths` (and under
        // them) a username and an app password (created on the auth-server account page) are accepted as well as a JWT: the
        // credentials are checked by auth-server (`GET /api/auth/password`), whose rules for two-factor sign-in still apply, and
        // it answers with an ordinary access token. A username that is a mailbox address is checked as the mailbox's owner.
        // Nowhere else accepts Basic - an app password skips the second factor and is meant for exactly these clients. A 401 on
        // these paths carries `WWW-Authenticate: Basic realm="<realm>"`, which is what makes a client ask for credentials.
        // A successful login is remembered for `cache_ttl_ms` (never past the token's expiry) because these clients send their
        // credentials with every request; `failure_limit` failed logins within `failure_window_ms` from one client address for one
        // username get a 429 until the window passes, as do `ip_failure_limit` from one address (any names) and `name_failure_limit`
        // for one username (any addresses) - looser, and the last only delays (`name_delay_ms` per failure past it, up to ten times that), so a stranger can't lock the owner out. Needs `mail:auth_server_url`. See lib/BasicAuthJWTStrategy.ts.
        basic_auth: {
            enabled: true,
            paths: ["/mapi", "/Microsoft-Server-ActiveSync"],
            realm: "RapidMX",
            cache_ttl_ms: 300_000,
            cache_max_entries: 5000,
            failure_limit: 10,
            ip_failure_limit: 50,
            name_failure_limit: 50,
            name_delay_ms: 1000,
            failure_window_ms: 900_000,
        },
        // `default_quota_bytes` and `auto_provision.enabled`/`quota_bytes` seed the admin-editable mailbox policy
        // (system/mailbox-policy) the first time it's read, and stay its fallback for anything it leaves unset.
        default_quota_bytes: 5_000_000_000,
        auto_provision: {
            enabled: true,
            quota_bytes: 5_000_000_000,
            timeout_ms: 10_000
        },
        // Read by @rapidmx/autodiscover-plugin (see `system.plugins.defaults`), where it's also a setting in the
        // admin console. Must be this deployment's externally-reachable https:// base URL (e.g.
        // `https://mail.example.com`) - the same host DNS setup (mail:dns:mx_hostname) and TLS already point at
        // - since both the EAS (`/Microsoft-Server-ActiveSync`) and MAPI (`/mapi/emsmdb`) endpoint URLs the
        // plugin advertises to real mail clients are built by appending a path to it. Empty by default:
        // Autodiscover then answers nothing rather than pointing a client at a host that isn't this deployment.
        // Not set here. A plugin version whose setting defaults to `https://<host>` gets the host when it is seeded at first
        // start (`mail:dns:mx_hostname`, which the chart sets), or the address the admin console was reached at when an
        // administrator installs it. The Helm chart also sets mail__autodiscover__public_url to `https://<host>` (its `host`),
        // which covers a plugin version whose default is empty and a plugin added before this was set: an empty saved setting
        // doesn't override configuration. Set mail__autodiscover__public_url to override.
        autodiscover: {
            public_url: "",
        },
        // `BaseBrandingRoute` builds a self-hosted logo/stylesheet's public URL as `${public_url}` +
        // a literal `/branding/logo`/`/branding/stylesheet`, which assumes the route is mounted at bare
        // `/branding` — but this repo mounts it under `@ApiRoute("system/branding")` (real path
        // `/api/system/branding/...`). `/api/system` is the prefix that makes the concatenation land on the
        // real mounted URL.
        branding: {
            public_url: "/api/system",
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
                // commit real values here - set via the mail__blob__s3__access_key_id/
                // mail__blob__s3__secret_access_key env vars.
                access_key_id: "",
                secret_access_key: "",
            },
        },
        booking: {
            // Read by @rapidmx/booking-plugin (see `system.plugins.defaults`), where it's also a setting in the admin
            // console. The booking pages' address: confirmation emails link to `${public_url}/manage/${token}`, so
            // it's the same externally-reachable base URL as `cluster_url` below with `/book` (the plugin's mount)
            // appended. Empty by default: booking emails then leave out the manage link rather than pointing at a host
            // that isn't this deployment. The Helm chart sets it from its `host` value; set `mail__booking__public_url`
            // otherwise. A non-empty value saved in the admin console wins over the environment variable; an empty one doesn't.
            public_url: "",
        },
        compose: {
            // Caps the combined size of a draft's attachments `BaseMailComposeRoute.assemble()` will load into
            // memory at once to build MIME — see `DEFAULT_MAX_COMPOSE_ATTACHMENT_BYTES` for the fallback used
            // when this is unset.
            max_attachment_bytes: DEFAULT_MAX_COMPOSE_ATTACHMENT_BYTES,
        },
        preferences: {
            // The largest background image a user may upload for the web client (`POST mail/preferences/appearance/background`), in
            // bytes; the route answers 413 above it. `max_body_size` is a separate, larger ceiling on every request.
            background_max_bytes: DEFAULT_APPEARANCE_BACKGROUND_MAX_BYTES,
        },
        search: {
            mongo: {
                datasource: "mongo",
            },
        },
        // Zero-access encryption (restapi specs/search.md §3): whether mailboxes may store mail encrypted at rest, until an
        // administrator saves "Allow zero-access encryption" (EncryptionPolicy.allowZeroAccess) in the admin console.
        zero_access: {
            allowed: true,
            // A zero-access message's attachments are indexed while the delivery waits (the plaintext exists only then): at most this
            // long in total, and none larger than extraction_max_bytes. What doesn't fit is left for the user's app to index.
            extraction_budget_ms: 5000,
            extraction_max_bytes: 10 * 1024 * 1024,
            // A week's search index entries may be compacted into one segment this long after the week ends (late mail waits for
            // the next generation), and a segment a client uploads may be at most max_segment_bytes.
            compaction_grace_hours: 24,
            max_segment_bytes: 64 * 1024 * 1024,
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
        // With NODE_ENV dev/development/test, an rspamd/clamd that can't be connected to at all is bypassed (scans
        // treated as clean, with a periodic warning) so `yarn dev` can send without that stack - see
        // dev/registerMailProviders.ts. Every other NODE_ENV still fails closed.
        scan: {
            spam: {
                rspamd: {
                    url: "http://localhost:11333",
                    // rspamd's controller worker, which `POST /api/mail/messages/:id/report` teaches (`/learnspam`, `/learnham`) when a
                    // user reports a message; the scan worker above has no such endpoint. Empty: `url` with its port replaced by 11334,
                    // rspamd's stock layout (env var mail__scan__spam__rspamd__controller_url; the Helm chart sets it to http://rspamd:11334).
                    controller_url: "",
                    // The controller's password, sent as the `Password` header. Empty sends none, which rspamd accepts only from its
                    // controller's secure_ip (loopback) - so leave it empty for a rspamd on the same host, and set it for any other. Env var
                    // mail__scan__spam__rspamd__controller_password; the Helm chart generates one (Secret `<release>-rspamd`) and gives the
                    // same value to rspamd. Unlike the secrets above it is not checked at startup: empty just makes learning fail, which a
                    // report answers with `learnSkipped: "failed"` after the message has been moved.
                    controller_password: "",
                    // How long a learn request may take before it is abandoned (learning is best-effort, so shorter than a scan's 15 s).
                    controller_timeout_ms: 10_000,
                },
                learn: {
                    // Whether a report teaches rspamd at all (env var mail__scan__spam__learn__enabled). Off, a report still moves and marks
                    // the message, and answers `learnSkipped: "disabled"`. rspamd also needs a statistics backend for its Bayes classifier
                    // (Redis), or every lesson fails - docker-compose.mail.yml's rspamd has none, so learning against it reports "failed";
                    // with NODE_ENV dev/development/test an rspamd that can't be connected to at all is treated as having learned (see
                    // dev/DevScanBypass.ts).
                    enabled: true,
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
            // Which `MailTransport` sends outbound mail (see dev/registerMailProviders.ts, and
            // `mail:blob:backend` above for the same config-driven pattern): `"postfix"` (default)
            // relays through the `postfix-bridge` deployment's Postfix, `"ses"` hands each message to
            // AWS SES's SendEmail API (`SesMailTransport`), for a deployment receiving through
            // `ses-bridge` instead of Postfix. Any other value falls back to `"postfix"`.
            provider: "postfix",
            // Only read by `SesMailTransport` (provider `"ses"`). Credentials come from the standard
            // AWS credential chain (an IAM role in any real deployment), never from config.
            ses: {
                // Empty leaves the region to the SDK's own resolution (env var, shared config, instance
                // metadata).
                region: "",
                // Optional SES configuration set for delivery/bounce/complaint event tracking.
                configuration_set: "",
            },
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
            // Rotation of the keys the server made itself (DkimRotationJob, restapi specs/dns_publishing_and_integrations.md 6.2). A domain keeps
            // the global selector above until its first rotation, which mints rmx<yyyymmdd>. A domain whose key was imported by hand, the SES
            // transport and a key provider that cannot rotate are never rotated; "Rotate now" in the admin console works whatever `enabled` says.
            rotation: {
                // Whether rotations start on schedule (also the text false, 0, no or off). A rotation in progress still finishes. On because the
                // chart pins a postfix-bridge release with per-domain selectors (helm/Chart.yaml, newer than 1.5.0): 1.5.0 never acknowledges a
                // switch, so a rotation started under it could not finish. test/jobs/DkimRotationJob.test.ts ties this value to that pin.
                enabled: true,
                // Days since the latest of the last rotation, the last cancelled one and the domain's creation before a new rotation starts.
                interval_days: 180,
                // Days the old record stays published after signing has switched, for mail still in queues or verified later.
                overlap_days: 7,
                // Hours the new record must have been live in DNS before signing switches to it, so receivers' resolvers drop a cached "no such record".
                publish_grace_hours: 48,
                // Size of every new RSA key, a whole number from 2048 to 4096; anything else is 2048 with a warning.
                key_bits: 2048,
                // At most this many rotations start per run and server copy, so the first run, when every older domain is due, spreads the new keys
                // and records over several runs.
                max_starts_per_run: 10,
            },
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
        // The domains this deployment is installed for (restapi spec 13): each entry is a domain name or an object of name, dnsProvider, dmarcPolicy,
        // dmarcReportEmail and aliasOf, or a comma-separated string of names. The server creates the ones it has not seeded before at every start, before it
        // reports ready (DomainSeeder: never again after the administrator deleted one, never changing one that exists). The chart renders it from global.domain and
        // postfixBridge.domains (mail__domains, JSON); `yarn dev` seeds example.com. `"bootstrap"` as an entry's dnsProvider is the installer's DNS provider below.
        domains: [],
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
            // The DNS controller's API (/internal/dns, DNS publishing): the one ServiceAccount whose projected token it accepts,
            // `system:serviceaccount:<namespace>:<fullname>-dns-controller`, which a chart that deploys the controller sets (mail__dns__controller__subject).
            // Empty refuses every call, which is what a deployment without the controller wants.
            controller: {
                subject: "",
            },
            // Automatic takeover (restapi spec 9.3): a provider config with allowTakeover has the records in conflict taken over by the server after the
            // controller's status report, at most one pass per this many seconds.
            takeover: {
                min_interval_seconds: 60,
                // How long a domain or host set found with nothing to take over is not looked at again while its endpoint stays as it is.
                recheck_seconds: 21600,
            },
            // The DNS provider config the installer asked for (--dns-provider), created once at start-up and before the server reports ready, with origin
            // "installer" (restapi spec 12.1): JSON (the chart renders it into the service ConfigMap) of { name, type, zones, options } and allowTakeover for
            // --dns-takeover, checked as the admin console checks a new one. Empty, an installation without a DNS provider. It is made only while no config of
            // the installer exists, so a restart or the administrator's edits never meet a second one or an overwritten one.
            bootstrap_provider: "",
            // Where the Secret `<fullname>-dns-bootstrap` is mounted (optional; only the server pod mounts it): one file per credential of the provider's type
            // (apiToken, accessKeyId, ...). The credentials are encrypted into the config's row, and the installer deletes the Secret once the rollout is ready.
            bootstrap_credentials_dir: "/etc/rapidmx/dns-bootstrap",
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
                // Never commit a real token here - set via the mail__pki__openbao__token env var
                // (nconf's `__`-separated env-var convention, see conf.env({ separator: "__" }) above).
                token: "",
                timeout_ms: 5_000,
                serial_map_path: "/var/lib/rapidmx/pki/openbao-serials.json",
                // A PEM bundle to verify OpenBao's listener with, instead of the system's trust store: the CA the installer copies into the
                // release's namespace (the chart mounts it at /etc/rapidmx/openbao-ca/ca.crt). Read on every request.
                ca_file: "",
                // How the client logs in. "token" (default) sends `token` above; "kubernetes" logs in to OpenBao's kubernetes auth method
                // (mounted at mount_path) as `role`, with the pod's projected ServiceAccount token at token_file (audience "openbao"),
                // and logs in again before the short-lived OpenBao token it gets expires. The chart sets these with openbao.auth.
                auth: {
                    method: "token",
                    role: "",
                    mount_path: "kubernetes",
                    token_file: "/var/run/secrets/openbao/token",
                },
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
                // How often AcmeEnrollmentDriverJob checks a pending enrollment, in seconds - only what the
                // enrollment status's `nextCheckAt` is computed from, so keep it equal to
                // `jobs.acme_enrollment_driver.schedule` (every 5 minutes by default).
                poll_interval_seconds: 300,
                // How long a request may wait on the CA before it is failed (`order-expired`) when the CA did not say
                // when its ACME order expires.
                max_pending_hours: 168,
            },
        },
        // AcmeEnrollmentDriverJobMongo's own schedule/config - registered unconditionally regardless of
        // `mail:pki:signing_enrollment:backend` (see server.mongo.ts's own comment on why), so this is
        // harmless to leave at its default even when RFC 8823 automation isn't enabled.
        jobs: {
            scheduled_send: {
                // Relays a background send (`POST mail/messages/:id/send` with `{ background: true }`) and a scheduled send: how many
                // messages are scanned and relayed at once in this process. Scanning is CPU work on the main thread, so more is
                // not faster past a few. (A single-connection SQLite datastore always runs one.)
                concurrency: 4,
                // How long a shutdown waits for relays in flight to finish before stopping anyway (one still running is finished by
                // the next process - it is never relayed twice).
                drain_ms: 15_000,
            },
            zero_access_backfill: {
                // Seals mail a mailbox already had when zero-access encryption became active for it: once a minute, at most
                // batch_size messages per run across all mailboxes, newest first.
                schedule: "0 * * * * *",
                batch_size: 100,
                // Days a scheduled Outbox message deleted from a zero-access mailbox stays readable (restoring it resumes the send),
                // counted from the later of its scheduled time and its deletion; after that it is sealed and its schedule cleared.
                deleted_scheduled_send_days: 30,
            },
            meeting_scheduling: {
                // How often MeetingSchedulingJob mails invitations, updates and cancellations to a meeting's guests, cron syntax
                // (seconds field included): every 10 seconds, so guests hear of a meeting that was deleted or cancelled within
                // moments rather than at the next 5-minute run. Each run is a few indexed queries.
                schedule: "*/10 * * * * *",
            },
            dkim_rotation: {
                // How often DkimRotationJob moves the domains through the phases of a rotation, cron syntax (seconds field included): hourly. It runs on
                // every server copy; a run with nothing due reads the domains and returns.
                schedule: "0 0 * * * *",
            },
            acme_enrollment_driver: {
                // Every 5 minutes, cron syntax (seconds field included).
                schedule: "0 */5 * * * *",
                expiry_warning_days: 30,
                // How many checks of the certificate authority in a row must fail before a SIGNING_ENROLLMENT_CA_UNREACHABLE audit entry is
                // written (once per run of failures) - the failure itself is logged at warn on the first one and whenever the error changes.
                failure_audit_after: 3,
            },
        },
    },
    giphy: {
        // Whether GIF search is offered at all; the console's Integrations can turn it off (the key alone decided before). Without a key it is unavailable either way.
        enabled: true,
        api_key: DEFAULT_GIPHY_API_KEY,
    },
    // The configuration keyring (restapi specs/dns_publishing_and_integrations.md section 5): the AES-256-GCM key that the credentials,
    // API keys and tokens saved in the admin console (DNS providers, Giphy, the plugin registry and its namespaces, a plugin's secret settings) are encrypted
    // with in the database. A database dump or backup alone reveals none of them, and is useless without the keyring - back both up together.
    // A production server refuses to start without one; `yarn dev` generates one into data/config-keyring.json.
    config_encryption: {
        // The keyring: a JSON document { "keys": [ { "kid", "key" (32 bytes, base64), "createdAt" } ] }, in a file (the chart mounts its Secret at
        // /etc/rapidmx/config-keyring/keyring.json) or, for development and tests, as the JSON itself. The file wins when both are set. It is re-read every
        // minute, so a key a rotation adds reaches every process without a restart.
        keyring_file: "",
        keyring: "",
        // Where the server writes a new keyring when an administrator rotates the key: "kubernetes" (the Secret secret_name; the chart's choice without
        // OpenBao), "openbao" (the KV v2 secret kv_mount/kv_path, which External Secrets syncs into that Secret; the chart's choice with OpenBao), "file"
        // (keyring_file; `yarn dev`) or "none" (a keyring given inline: rotation is refused).
        keyring_store: {
            backend: "none",
            secret_name: "",
            kv_mount: "secret",
            kv_path: "",
        },
        // A new key encrypts only once every running server copy has reported loading it: each copy reports every heartbeat_seconds (and is dropped
        // three beats after it stops), and the console warns after warn_minutes that the usual cause is a node that hasn't refreshed the Secret.
        activation: {
            heartbeat_seconds: 30,
            warn_minutes: 15,
        },
        // How often ConfigKeyRotationJob looks for work (cron syntax, seconds field included); a run with no rotation in progress reads one row and returns.
        rotation: {
            schedule: "*/30 * * * * *",
        },
        // Rows re-encrypted per page by a rotation.
        reencrypt: {
            batch_size: 100,
        },
        // Plugin secret settings are encrypted in their rows once every pod of the server Deployment runs this release (a pod of the previous one would hand a
        // plugin an envelope as a value). pod_selector is the label selector of those pods, which the chart renders; wait_for_rollout: false skips the check, for
        // an operator who has checked the rollout. Outside Kubernetes it runs at once.
        plugin_secrets: {
            pod_selector: "",
            wait_for_rollout: true,
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
                { name: "@rapidmx/activesync-plugin", version: "latest", enabled: true },
                { name: "@rapidmx/autodiscover-plugin", version: "latest", enabled: true },
                { name: "@rapidmx/booking-plugin", version: "latest", enabled: true },
                { name: "@rapidmx/mapi-plugin", version: "latest", enabled: true },
                { name: "@rapidmx/meet-plugin", version: "latest", enabled: true },
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
            // Ceiling, in bytes, on the total installed node_modules size - see PluginInstaller.ts's
            // DEFAULT_MAX_INSTALL_BYTES for the default (500MB) and full rationale (bounds what a malicious or
            // compromised registry package can pull onto disk). 0 disables the check.
            max_install_bytes: 500 * 1024 * 1024,
            // Installing a plugin by uploading its `npm pack` file (.tgz), which an elevated administrator may do (it skips the
            // allow-list above: they vouch for that code). The packs are stored in the blob store (mail:blob) and every copy
            // installs them from there at startup, so the blob store has to be shared when there is more than one copy.
            uploads: {
                // Turned off, the upload route answers 403 and uploaded plugins already installed stop loading (reported in the status).
                enabled: true,
                // The largest pack accepted, in bytes. Raise `max_body_size` and any proxy's body limit with it.
                max_bytes: 50 * 1024 * 1024,
            },
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
    // `RateLimiter`), which backs every `@RateLimit()`-decorated endpoint in `@rapidmx/restapi` and its plugins -
    // the booking plugin's three mutating endpoints and the public key-discovery endpoint (both reachable anonymously;
    // booking emails the booker), AND `GET /mailbox/:id/keys/lookup`, which every logged-in user's compose flow calls
    // once per new recipient.
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

// The datastore service-core publishes push events through - see ensurePushDatastore().
ensurePushDatastore(conf);

export default conf;
