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
        blob: {
            local: {
                // Local filesystem root for raw MIME sources, sanitized HTML, attachment binaries, extracted
                // attachment text, and contact photos (see `LocalFsBlobStore`). Must be a persistent volume
                // in any real deployment.
                root: "./data/blobs",
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
        scan: {
            spam: {
                rspamd: {
                    url: "http://rspamd:11333",
                },
            },
            av: {
                clamav: {
                    host: "clamav",
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
            // ManualSigningCertificateEnrollment's on-disk store of in-flight CSR enrollments awaiting a
            // human to paste the CA-issued certificate back in. Automated RFC 8823 ACME enrollment is
            // tracked separately and not yet an option here.
            manual_enrollment: {
                store_path: "/var/lib/rapidmx/pki/manual-enrollments.json",
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
    // Exact IP addresses of proxies/load balancers this server sits behind and trusts to set
    // X-Forwarded-For/X-Real-IP truthfully. Left empty by default (fail closed: forwarding headers are
    // ignored and NetUtils.getIPAddress() falls back to the socket's own remote address), which is safe
    // but means per-IP rate limiting and audit-log IPs will all collapse onto the proxy's own address in
    // any deployment that actually sits behind one (the common case in production). Set this to your
    // reverse proxy/load balancer's IP(s) if you deploy behind one.
    trusted_proxies: [],
});

export default conf;
