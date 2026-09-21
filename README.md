# RapidMX: Mail Server

[![CI](https://github.com/rapidmx/server/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/rapidmx/server/actions/workflows/ci.yml)
[![Coverage Status](https://coveralls.io/repos/github/rapidmx/server/badge.svg?branch=main)](https://coveralls.io/github/rapidmx/server?branch=main)
[![package version](https://ghcr-badge.egpl.dev/rapidmx/server/latest_tag?trim=major&label=latest)](https://github.com/rapidmx/server/pkgs/container/server)

A reference implementation of a RapidMX mail server, providing a complete, deployable mail service that includes a web mail (React) client as well as Exchange ActiveSync, and MAPI support.

### Key Features

* Web Mail
* Exchange ActiveSync
* MAPI over HTTP
* Autodiscover
* Booking pages

## Getting Started

To get started using this service first clone the source. It is highly recommended that you fork the project first.

```bash
git clone https://github.com/rapidmx/server
```

## Deployment

| Docker Image |                       |
| ------------ | :-------------------: |
| Registry     | ghcr.io |
| Repository   | /rapidmx/server |
| Tag          | 1.0.0-beta.9 |

A RapidMX deployment is this server, the separate [`auth-server`](https://github.com/rapidrest/auth-server) it verifies
sign-ins against, MongoDB or PostgreSQL, Redis, rspamd and ClamAV (inbound spam and virus scanning), and a mail transport:
Postfix with [`postfix-bridge`](https://github.com/rapidmx/postfix-bridge), or SES on AWS. Pick the way to run it that fits:

| | Use it for | Mail transport | HTTPS |
| --- | --- | --- | --- |
| [1. Docker Compose](#1-docker-compose) | Trying it out on one machine, or one host you put your own reverse proxy in front of | Postfix, from postfix-bridge's own compose file | Yours |
| [2. An existing Kubernetes cluster](#2-an-existing-kubernetes-cluster-helm) | A cluster you already run | Postfix, installed with the chart | cert-manager (Let's Encrypt) through a Gateway API Gateway |
| [3. A standalone k3s server](#3-a-standalone-k3s-server-single_node_installsh) | One Linux server, one command | Postfix, installed with the chart | Let's Encrypt, set up by the script |
| [4. AWS](#4-aws-cloudformation) | One EC2 instance | SES | Let's Encrypt, set up by the script |

Every one of them needs the same few things from you, described next: DNS names, open ports and, for each mail domain, DNS
records.

### Before you deploy

**Names and DNS.** A deployment is served at two host names under the domain your mail is addressed to (say `example.com`):
the server at `mail.example.com` and the auth-server, where sign-in happens, at `auth.example.com`. Create an `A` record
(and `AAAA`, if the machine has an IPv6 address that reaches it) for each name pointing at the server's public address
*before* you install: Let's Encrypt has to reach the machine on those names to issue the certificates. On AWS you create a
CNAME to the load balancer instead. The names are configurable (`--mail-host` and `--auth-host`, `MailHost` and `AuthHost`,
`host` and `authserver.host`), but the rest of this README uses the defaults.

**Ports.** `443` and `80` (HTTPS, and the HTTP that certificate issuance and the redirect to HTTPS use) and, wherever Postfix
runs, `25` for mail in both directions. Many cloud providers block outbound port 25 by default, and mail can't leave without
it - ask the provider to open it, or use SES. Let's Encrypt limits how often it will issue certificates for the same names, so
avoid reinstalling over and over against a real domain.

**Reverse DNS.** Receiving servers score mail from an address whose reverse DNS (PTR) record doesn't match the name it says hello
as. Postfix says hello as `mail.example.com`, so set the reverse record of the server's public address to it (at your hosting
provider - it isn't part of your zone). Not needed with SES.

**Mail DNS, per mail domain.** These come after the install, once, for each domain you receive and send mail as: sign in,
open the admin console (`https://mail.example.com/admin`), add the domain under **Domains** and publish the records its **DNS
setup checklist** shows, which it checks live. They are:

| Record | Name | Value |
| --- | --- | --- |
| Ownership (TXT) | `example.com` | `rapidmx-domain-verification=<token>` |
| MX | `example.com` | `10 mail.example.com` |
| SPF (TXT) | `example.com` | `v=spf1 mx ~all` |
| DKIM (TXT) | `mail._domainkey.example.com` | `v=DKIM1; k=rsa; p=<public key>` |
| DMARC (TXT) | `_dmarc.example.com` | `v=DMARC1; p=none;` (add `rua=mailto:<address>` to get reports) |

Until the ownership record is found the domain isn't *verified* and can't send or receive. With SES the records differ
(SES's own DKIM CNAMEs and its MX); see [4. AWS](#4-aws-cloudformation). You may add more domains at any time: with the
bundled Postfix in Kubernetes (2 and 3) a new domain works within seconds, with nothing to restart, redeploy or upgrade.

### 1. Docker Compose

Needs Docker Engine with Compose v2.20 or later, and a few GiB of memory (ClamAV alone loads about 1 GiB of virus
signatures, which takes a few minutes on first start).

Pick `docker-compose.mongo.yml` or `docker-compose.sql.yml` depending on which datastore backend you want (MongoDB or
PostgreSQL) — there is no plain `docker-compose.yml`. Either one, on its own, brings up this service, the
`auth-server` it verifies JWTs against (`ghcr.io/rapidrest/auth-server`, pulled, not built), Redis, the database and
rspamd/ClamAV — but *not* real inbound/outbound mail transport, which comes from `postfix-bridge` (below).

```bash
git clone https://github.com/rapidmx/server
cd server
docker compose -p rapidmx -f docker-compose.mongo.yml up -d --build
```

This is for local evaluation: the stack runs with `NODE_ENV=dev`, uses publicly-known placeholder secrets and publishes every
port on the host's loopback address (`127.0.0.1`) only. The server is at <http://localhost:3000> and sign-in at
<http://localhost:3001>. The auth-server creates an `admin` account with a random password on its first start and writes it
to a file inside its container, which it deletes at its next restart, so read it now:

```bash
docker compose -p rapidmx -f docker-compose.mongo.yml exec auth-server cat /app/passwords
```

**Going beyond localhost.** Set `NODE_ENV=production` and replace every placeholder in a `.env` file next to the compose
files (the server refuses to start with the placeholders unless `NODE_ENV` is `dev`, `development` or `test`; see
`src/config.defaults.ts`). A minimal one for `example.com`:

```bash
NODE_ENV=production
PUBLIC_URL=https://mail.example.com
AUTH_SERVER_PUBLIC_URL=https://auth.example.com
MX_HOSTNAME=mail.example.com
AUTH_AUDIENCE=example.com
AUTH_ISSUER=auth.example.com
AUTH_SECRET=<openssl rand -hex 32>
COOKIE_SECRET=<openssl rand -hex 32>
SESSION_SECRET=<openssl rand -hex 32>
AUTH_OAUTH_SERVER_ENCRYPTION_KEY=<openssl rand -hex 32>
ESCROW_AUDIT_HMAC_KEY=<openssl rand -hex 32>
MAIL_INGEST_SECRET=<openssl rand -hex 32>
```

| Variable | Purpose |
| --- | --- |
| `AUTH_SECRET` | JWT signing secret — must match between this service and `auth-server` exactly |
| `AUTH_AUDIENCE` / `AUTH_ISSUER` | JWT `aud`/`iss` claims — must also match `auth-server` |
| `AUTH_SERVER_PUBLIC_URL` | Browser-facing base URL of `auth-server` (defaults to `http://localhost:3001`, dev/single-host only); also its OAuth issuer |
| `AUTH_OAUTH_SERVER_ENCRYPTION_KEY` | `auth-server`'s OAuth key-encryption key (`auth__oauth_server__keys__encryption_key`) |
| `COOKIE_SECRET` | Shared cookie-signing secret |
| `SESSION_SECRET` | `auth-server`'s session-signing secret |
| `ESCROW_AUDIT_HMAC_KEY` | Key for the escrow audit log's HMAC-SHA256 hash chain (`mail:escrow:audit_hmac_key`) — generate once (`openssl rand -hex 32`) and never change it; unset, entries are chained with unkeyed SHA-256 and the server logs an error in production |
| `MAIL_INGEST_SECRET` | Bearer secret authenticating `postfix-bridge`'s calls to this app's `/internal/mta` routes — must match that repo's own `MTA_INGEST_SECRET` exactly |
| `PUBLIC_URL` | This deployment's public base URL (defaults to `http://localhost:3000`) — the booking plugin's email links and the autodiscover plugin (which requires `https://`) |
| `MX_HOSTNAME` | Public MX hostname (defaults to `localhost`) — outgoing read receipts and domain DNS checks |
| `SENDMAIL_RELAY_HOST` / `_PORT` / `_TLS` | Where `PostfixSendmailTransport` relays outbound mail — defaults to `host.docker.internal:25` (TLS off), i.e. wherever the separate `postfix-bridge` stack publishes its own Postfix on the host's `localhost:25`; override for anything beyond local, single-host evaluation |

Three things the compose file doesn't do for you:

- **HTTPS.** Neither service terminates TLS. Put a reverse proxy on the host (Caddy, nginx, Traefik, ...) that terminates it for
  `mail.example.com` → `127.0.0.1:3000` and `auth.example.com` → `127.0.0.1:3001`, and leave the published ports on the loopback
  address. Set the server's `trusted_proxies` if you want its rate limits and audit log to see real client addresses.
- **A shared sign-in cookie.** The server and the auth-server are on different host names, so the auth-server has to set its
  session cookies for the parent domain, which the compose file has no variable for. Add them from a second compose file,
  `docker-compose.prod.yml`, and start both together
  (`docker compose -p rapidmx -f docker-compose.mongo.yml -f docker-compose.prod.yml up -d`):

  ```yaml
  services:
    auth-server:
      environment:
        - auth__cookie__access__domain=.example.com
        - auth__cookie__refresh__domain=.example.com
  ```

- **Mail.** Real mail transport is [`postfix-bridge`](https://github.com/rapidmx/postfix-bridge)'s own compose file (Postfix, DKIM
  signing and the bridge to `/internal/mta`), which you run *alongside* this one, not instead of it. Run both in the same
  compose project (`-p rapidmx`, as in these commands): they then share a network, so each finds the other by service name, and the
  `dkim_rspamd_keys` volume, which is how Postfix signs with the keys this server publishes. In this checkout's `.env`, add
  `SENDMAIL_RELAY_HOST=postfix`; then, from a checkout of postfix-bridge, with this in its `.env`:

  ```bash
  MAIL_HOSTNAME=mail.example.com
  MAIL_DOMAINS=example.com
  MTA_INGEST_BASE_URL=http://server:3000/internal/mta
  MTA_INGEST_SECRET=<the same value as MAIL_INGEST_SECRET>
  ```

  run `docker compose -p rapidmx up -d --build`. Compose warns about "orphan containers" whenever you run one of the two files
  afterwards; that is expected, and you should never answer it with `--remove-orphans`. Postfix publishes port 25 and
  requires TLS from other mail servers, and it starts with a self-signed certificate: copy a real one for
  `mail.example.com` into its `postfix_tls` volume as `tls.crt` and `tls.key` and restart it. Unlike Kubernetes, a domain you
  add in the admin console has to be added to `MAIL_DOMAINS` and Postfix restarted (`docker compose -p rapidmx restart
  postfix`) before it can send and sign. See postfix-bridge's README for the rest.

The `dkim_rspamd_keys`/`mongo_data`/`postgres_data`/`blob_data` named volumes persist DKIM keys, database contents and
message/attachment storage across `docker compose down`/`up` — don't remove them (`docker compose down -v`) unless you
actually want to start over.

**Mail transport security** (Postfix's TLS posture, the `postfix-bridge` hop, DKIM/DMARC) is documented in the
[`postfix-bridge`](https://github.com/rapidmx/postfix-bridge) repo's own README. The one thing that lives on this side:
`server` → Postfix (`PostfixSendmailTransport`/msmtp) is unencrypted by default (`SENDMAIL_RELAY_TLS`, defaulting to
`off`), since that hop is internal.

### 2. An existing Kubernetes cluster (Helm)

The chart installs everything in the table above (the database, Redis, rspamd, ClamAV, the auth-server and Postfix with
postfix-bridge) into one namespace. What the *cluster* has to provide, because the chart can't bring cluster-wide pieces along:

- **Helm 3.8 or later** (the chart is an OCI artifact), and a default `StorageClass`: the message store (20 Gi), DKIM keys,
  PKI and the database each get a volume.
- **A Gateway API controller** with its CRDs, and a `GatewayClass` whose name is `global.gateway.className` (default `envoy`, as
  with [Envoy Gateway](https://gateway.envoyproxy.io/)). The chart creates a `Gateway` for each of its two host names, or
  attaches its routes to one you already have (below), and terminates TLS there. The cluster must send traffic for both host
  names on ports 80 and 443 to it.
- **cert-manager with Gateway API support** (`config.enableGatewayAPI=true`), which the chart's own Issuer uses to get Let's
  Encrypt certificates over HTTP-01 through that Gateway. Or set `global.gateway.tls=false` to serve plain HTTP.
- **A way to reach Postfix on port 25**: its `postfix` Service is a `LoadBalancer` (`postfixBridge.postfix.serviceType`) with
  `externalTrafficPolicy: Local`, which it needs to tell internet clients from cluster clients. Behind a load
  balancer that hides the client address Postfix becomes an open relay for your own domains: read postfix-bridge's README before
  exposing port 25.
- **OpenBao and External Secrets** only if you want the release's secrets in a vault (see [Secrets and OpenBao](#secrets-and-openbao)).

Then install, giving it the mail domain and the two secrets the sides share (generate them once and keep them):

```bash
helm upgrade --install --create-namespace --namespace rapidmx rapidmx oci://ghcr.io/rapidmx/charts/server --version 1.0.0-beta.9   --set global.jwt.secret="$(openssl rand -hex 32)" --set global.mailIngestSecret="$(openssl rand -hex 32)"   --set global.domain=example.com
```

With `global.domain=example.com` the server is served at `mail.example.com`, the auth-server at `auth.example.com` and Postfix is
`mail.example.com`, sending mail for `example.com`; the JWT audience and issuer follow (the domain and the auth host). Set
`host`, `authserver.host`, `postfixBridge.hostname` and `postfixBridge.domains` only to change those. Cookie, session and escrow
audit secrets are generated on the first install and kept. Add DNS for both names, wait for the pods (`kubectl -n rapidmx get
pods`; ClamAV takes a few minutes) and for the certificates (`kubectl -n rapidmx get certificate`), and [sign in](#after-the-install-sign-in-and-add-your-domain).

To install from a checkout instead of GHCR:

```bash
helm repo add bitnami https://charts.bitnami.com/bitnami
helm dep up ./helm
helm upgrade --install --create-namespace --namespace rapidmx rapidmx ./helm --set global.jwt.secret="$(openssl rand -hex 32)" --set global.mailIngestSecret="$(openssl rand -hex 32)" --set global.domain=example.com
```

The install command is also the upgrade command; see [Upgrading](#upgrading). Pass the same `global.jwt.secret` and
`global.mailIngestSecret` again on later runs, or rely on `--reset-then-reuse-values` to keep them.

#### Chart reference

Real inbound/outbound mail transport (Postfix, DKIM signing and [`postfix-bridge`](https://github.com/rapidmx/postfix-bridge)) is the
`postfixBridge` dependency, installed with the chart. `postfixBridge.hostname` is Postfix's MX
host name (default `mail.<global.domain>`), which gets a Let's Encrypt certificate from the chart's own cert-manager Issuer, and
`postfixBridge.domains` the domains Postfix knows when it starts (default `<global.domain>`; every domain you add in the admin console works
at once, without a restart or an upgrade); the render fails if a public `host` is left with a placeholder for either. The chart also
issues the server's own certificate for the same name, so to have Postfix present that one rather than ask Let's Encrypt for a second (it
limits duplicates) set `postfixBridge.tls.existingSecret` to `<host>-tls-cert`, as `single_node_install.sh` does. Without cert-manager, set `postfixBridge.tls.certManager.enabled=false` for a self-signed certificate, or
`postfixBridge.tls.existingSecret` to your own. Postfix signs mail with the DKIM keys the server writes to its
`mail.dkim.storage` volume, so with the default `ReadWriteOnce` both pods must run on the same node. Set `postfixBridge.create=false` to install postfix-bridge as its
own release instead; the release notes (`helm get notes`) then say how to connect it.

On AWS, set `mail.transport.provider=ses` with `postfixBridge.create=false` to send through SES instead of Postfix
(`mail.transport.ses.region`, and inbound mail through [`ses-bridge`](https://github.com/rapidmx/ses-bridge)); the render
fails if both are on at once. The pod gets its AWS credentials from `serviceAccount.create` with an
`eks.amazonaws.com/role-arn` annotation (IRSA) or from the node's own role, and `mail.ingestService.enabled` adds an
internal load balancer for `/internal/mta`, which ses-bridge's Lambda calls from inside the VPC - the public Gateway
still answers 404 for `/internal`. Restrict it with `mail.ingestService.loadBalancerSourceRanges`.

The bundled auth-server sends its sign-in and verification codes by e-mail, which it can only do over SMTP, so it has its own
settings, `global.smtp` (the auth-server subchart can't read `mail.*`). They default to the bundled Postfix over the cluster
network (host `postfix`, port 25, no TLS on that hop) from `noreply@<global.domain>` (`global.smtp.from`). With SES, point
`global.smtp.host` at `email-smtp.<region>.amazonaws.com` (port 587, `ignoreTLS=false`, `requireTLS=true`) and give it an SES
SMTP account's `smtp_config__auth__user` / `smtp_config__auth__pass` from a Secret through `authserver.service.extraEnv`
(`deploy/aws/bootstrap.sh` does all of this from `RAPIDMX_SES_SMTP_USERNAME` and `RAPIDMX_SES_SMTP_PASSWORD`).

`global.domain` is the deployment's mail domain (e.g. `example.com`): mail is addressed `@<domain>`, the server is served
at `host` (`mail.<domain>` by default), the auth-server at `authserver.host` (`auth.<domain>` by default), and the JWT audience
and issuer are the domain and that auth host on both sides. Postfix's MX name and sender domains follow the same value.

##### Secrets and OpenBao

With `global.openbao.enabled` this release keeps its secrets in [OpenBao](https://openbao.org): the JWT signing secret
shared with auth-server, the cookie, session and escrow audit keys, the postfix-bridge ingest secret, and the certificate
authority for end-to-end encrypted mail (`mail:pki:backend`, an OpenBao PKI mount instead of the local CA on disk). [External Secrets](https://external-secrets.io) copies the values into the Kubernetes Secrets the pods already
load, so nothing in the application changes. The bundled auth-server reads the same vault path, so both sides share one
JWT secret without either value being passed in.

**OpenBao is a prerequisite, like cert-manager - the chart doesn't install it**, which is why the value is off by
default: a plain `helm install` shouldn't assume a vault is there. `single_node_install.sh` and `deploy/aws` do install
one and turn it on (`--openbao true` / `RAPIDMX_OPENBAO`, on by default there): they install it, initialise it, keep the unseal
key in a Kubernetes Secret with an unsealer Deployment that re-unseals the vault after any restart, write this release's
secrets (each value once - never rewritten, so an upgrade doesn't invalidate sessions or re-key the escrow chain), set up
the PKI mount and issuing role, and create the two token Secrets. External Secrets has to be there too; its CRDs are
cluster-wide, so the chart can't bring it, and the render fails with the exact command when it's missing.

Point `global.openbao.address` at an OpenBao you already run to use that one instead (`auth.method: kubernetes` avoids
storing a token at all). It has to hold, under `global.openbao.kvMount` at `global.openbao.secretsPath`
(`<release>/secrets` by default), the fields `auth_secret`, `cookie_secret`, `session__secret`,
`escrow_audit_hmac_key` and `mail_ingest_secret`; `global.openbao.auth.tokenSecret` names a Secret whose `token` may read
them. For the encryption CA, a PKI mount (`openbao.pki.mount`) with an issuing role (`openbao.pki.role`) that accepts an
email address as the common name, and `openbao.pki.tokenSecret` naming a Secret whose `mail__pki__openbao__token` may
`update` on `<mount>/sign/<role>` and `<mount>/revoke` - the server signs client CSRs, so the CA key never leaves the
vault. Leave `openbao.pki.tokenSecret` empty to keep the local CA on the `pki-data` volume.

Keeping the unseal key in a Secret is what makes the deployment heal itself after a reboot, at the cost that anyone who
can read Secrets in the vault's namespace can unseal it (roughly what those Secrets exposed before). A cluster with a KMS
to auto-unseal from should run its own vault and be pointed at instead.

Left off (the chart's default), everything stays in Kubernetes Secrets, in which case:

The chart needs two secrets you supply: `global.jwt.secret` (the JWT secret, shared with the bundled auth-server, which reads
the same value: leave it out and each of the two generates its own, so the server rejects every sign-in) and
`global.mailIngestSecret` (shared with postfix-bridge; the render fails without it). Pass the same values
again on every upgrade (or use `--reset-then-reuse-values`). Cookie, session and escrow audit (`mail.escrow.auditHmacKey`) secrets are generated on install and
kept - which needs cluster access, so rendering the chart without it (`helm template`, Argo CD/Flux, `--dry-run`) fails
until you set `cookies.secret`, `sessions.secret` and `mail.escrow.auditHmacKey` explicitly or point
`secrets.existingSecret` at a Secret you manage. Outbound mail is relayed to postfix-bridge's `postfix`
Service (`mail.relay.*`). By default the chart creates a Gateway for each of its hosts (`host` and
`authserver.host`, `global.gateway.className`) and has cert-manager issue their certificates from an Issuer of its own
(`global.certmanager.*`, Let's Encrypt over HTTP-01 through that Gateway); `global.gateway.tls=false` serves plain HTTP.
To use one Gateway you already have, point `global.gateway.name` and `global.gateway.namespace` at it (the auth-server
subchart shares them). The route names no listener, so it attaches to every listener there that accepts the host, and with
TLS on the chart renders the ReferenceGrant that lets the Gateway read each `<host>-tls-cert` Secret in the release's
namespace - the Gateway needs an HTTPS listener for each host that terminates TLS with that Secret. With Envoy Gateway the
chart also attaches a `BackendTrafficPolicy` that compresses the API's JSON and the pages' HTML (brotli, else gzip;
`global.gateway.compression.enabled`: `auto` renders it when the cluster has that API, `true`/`false` force it; it does
nothing with `global.gateway.tlsTermination=pod`, where Envoy only passes the bytes through). The browser bundles and static
files are compressed by the server itself, and Envoy leaves a response that already carries `Content-Encoding` alone. The usual naming is
`host: mail.<domain>` with `authserver.host: auth.<domain>`, which is what `global.domain` alone gives you; sign-in redirects to
`authserver.host`. `mail.trustedAuthservId` is the authserv-id of the `Authentication-Results`
header your inbound MTA stamps, which the server trusts to say whether a sender's DKIM signature verified; with the bundled
Postfix it defaults to Postfix's host name (`postfixBridge.hostname`), and with any other MTA (ses-bridge, your own) you set it.
While it's empty no sender is DKIM-verified, so members-only distribution lists drop all mail, list and forward-rule
copies get a rewritten From, and forwarded invites are refused. `/api/metrics`
requires a token with a trusted role, so scrape it with a bearer token rather than `prometheus.io/*` annotations.

The chart runs one replica by default, because its message, DKIM and PKI volumes are `ReadWriteOnce`. To run more,
use `mail.blob.backend: s3` (or `ReadWriteMany` storage) and `ReadWriteMany` for `mail.dkim.storage` and
`mail.pki.storage`.

### 3. A standalone k3s server (`single_node_install.sh`)

For one Linux server (Debian, Ubuntu or a RHEL-family distribution, with `sudo`, and about 8 GiB of memory) the script sets up
everything in one go. Point the two DNS names at the server first (see above), make sure ports 25, 80 and 443 reach it, and
don't run Docker on the same host: it conflicts with k3s, and the script stops if it sees Docker running.

```bash
curl -fsSLO https://raw.githubusercontent.com/rapidmx/server/main/single_node_install.sh
chmod +x single_node_install.sh
./single_node_install.sh --domain example.com --email you@example.com
```

`--domain` is the mail domain: the server is served at `mail.<domain>`, the auth-server at `auth.<domain>`, and mail is
addressed `@<domain>`. `--mail-host` and `--auth-host` change those two names, as a label (`--mail-host rapidmx` gives
`rapidmx.<domain>`) or a whole host name. `--email` is the Let's Encrypt account address (default `admin@<domain>`).

It installs k3s, helm, [Envoy Gateway](https://gateway.envoyproxy.io/) (whose Service is only reachable inside the
cluster), nginx on the host forwarding ports 80 and 443 to it with the PROXY protocol (so the server sees real client
addresses), cert-manager, [OpenBao](https://openbao.org) and External Secrets (which keep the release's secrets), and this
chart, which has cert-manager issue the Let's Encrypt certificates. Postfix listens on port 25 (through k3s' ServiceLB) as
the server's host name, and every domain added in the admin console receives, sends and signs mail with nothing to restart
(`--mail-domains`, default `<domain>`, is only the set Postfix knows at start). When a host firewall is active (ufw on
Ubuntu/Debian, firewalld on RHEL/Fedora) it opens SMTP/HTTP/HTTPS and allows k3s' pod and service networks; under SELinux it
also allows nginx to relay.

| Option | |
| --- | --- |
| `--version <version>` | The chart version to install (the script pins the one it was released with) |
| `--tls false` | No cert-manager and no certificates: plain HTTP, and Postfix gets a self-signed certificate |
| `--gateway shared\|chart` | `shared` (default): the script creates one Gateway, `envoy-gateway-system/shared-gateway`, with an HTTPS listener per host, and the chart's routes attach to it. `chart`: the chart creates a Gateway for each host, which the script merges into one Envoy Service for nginx. Re-running the script switches between them |
| `--openbao false` | Keep the secrets in Kubernetes Secrets instead of OpenBao |
| `--skip-k3s` | Use the cluster `kubectl` already reaches, instead of installing k3s |
| `--uninstall` | Remove only what the script installed |

Set `CHART=./helm` in the environment to install the chart from a checkout instead of the published one, and
`ENVOY_GATEWAY_VERSION` to pick another Envoy Gateway release. `./single_node_install.sh --help` lists everything.

The certificates are requested at install and issued once both names resolve to the machine, so DNS may follow the install
(`kubectl -n rapidmx get certificate` shows when they're ready). To try it without a public domain, use a name ending in
`.local` (say `--domain example.local`), which serves plain HTTP with no certificates, and add the two host names to your hosts file,
which the script reminds you of.
Then [sign in](#after-the-install-sign-in-and-add-your-domain).

### 4. AWS (CloudFormation)

`deploy/aws/` deploys the same stack on one EC2 instance: one CloudFormation template that creates the network, an IAM role and
the instance, whose user data runs `deploy/aws/bootstrap.sh`, which installs k3s, Envoy Gateway behind a Classic Load Balancer
(forwarding TCP with the PROXY protocol), cert-manager, OpenBao, External Secrets and this chart. There is no nginx and no
Postfix: volumes are EBS and mail goes through SES. See [deploy/aws/README.md](deploy/aws/README.md) for the parameters and limits.

Before you start you need an AWS account with permission to create IAM roles and EC2 instances, the AWS CLI, the
domain's Route 53 hosted zone (optional, but it makes DNS automatic), and an SES domain identity for `example.com` in the region
you deploy to; new SES accounts start in the sandbox, which only sends to verified addresses until you ask AWS to lift it.

```bash
aws cloudformation deploy --stack-name rapidmx --template-file deploy/aws/rapidmx-server.yaml \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides Domain=example.com HostedZoneId=Z123EXAMPLE ChartVersion=<chart version>
```

`Domain` is the mail domain (the server is served at `mail.<Domain>`, sign-in at `auth.<Domain>`), not the server's own name.
Set `ChartVersion` to the release you want, because the template's default is an older one. With `HostedZoneId` the instance
creates the `mail` and `auth` records in that zone for you; without it, create both as CNAMEs to the load balancer named in the
install summary. The stack only reports success once the whole install has finished, so a failed install fails the stack.

Read the summary (it holds the load balancer's name, the generated secrets and the exact `ses-bridge` command) with the
`SummaryCommand` stack output, which uses Session Manager, and the addresses with
`aws cloudformation describe-stacks --stack-name rapidmx --query 'Stacks[0].Outputs'`.

Two things remain after the stack is up:

1. **Inbound mail: deploy [`ses-bridge`](https://github.com/rapidmx/ses-bridge)** for each mail domain, with the command the
   summary prints. Then publish its three DKIM CNAME records, point the domain's MX record at the value it outputs (priority 10) and
   activate its SES receipt rule set. (Its DKIM records also prove the domain to SES; RapidMX's own ownership TXT record from
   [Before you deploy](#before-you-deploy) is still needed for the admin console.)
2. **E-mail from the auth-server** (sign-in and verification codes). It can only send over SMTP, which can't use the instance's IAM
   role, so create an SES SMTP account and re-run `bootstrap.sh` on the instance with `RAPIDMX_SES_SMTP_USERNAME` and
   `RAPIDMX_SES_SMTP_PASSWORD` set (and optionally `RAPIDMX_MAIL_FROM`, default `noreply@<domain>`). Until then the auth-server's
   e-mail is switched off and the summary says so.

Then [sign in](#after-the-install-sign-in-and-add-your-domain).

### After the install: sign in and add your domain

Open `https://mail.example.com`: it sends you to `https://auth.example.com` to sign in as `admin`. The auth-server generated
that account's password at install; read it from the Secret it lives in, `<release>-authserver-service-secrets` in the release's
namespace (`rapidmx-authserver-service-secrets` in `rapidmx` for the k3s script, as here; on AWS run it as root on the instance with
`KUBECONFIG=/etc/rancher/k3s/k3s.yaml` and use `rapidmx-server-authserver-service-secrets` in `rapidmx-server`):

```bash
kubectl -n rapidmx get secret rapidmx-authserver-service-secrets -o jsonpath='{.data.default_accounts}' \
  | base64 -d | tr -d '\\' | sed -n 's/.*"password":"\([^"]*\)".*/\1/p'
```

(With Docker Compose, the password is in the file shown in [1. Docker Compose](#1-docker-compose).)
Then open the admin console at `https://mail.example.com/admin`, add your mail domain under **Domains**, publish the records in
its DNS setup checklist ([Before you deploy](#before-you-deploy)) and use **Verify now**.

### Upgrading

Upgrade the way you installed. **Back up the database first** (see below).

- **Docker Compose:** `git pull`, then the `up -d --build` command you started with.
- **Kubernetes, and a k3s server or AWS instance you installed with the scripts:** upgrade the release with `helm`. The scripts install a release named
  `rapidmx` in the namespace `rapidmx` (`rapidmx-server` on AWS, where you run it as root on the instance, over Session Manager, with
  `KUBECONFIG=/etc/rancher/k3s/k3s.yaml`):

  ```bash
  helm upgrade rapidmx oci://ghcr.io/rapidmx/charts/server --version <version> --namespace rapidmx \
    --reset-then-reuse-values --wait --timeout 10m
  ```

  `--reset-then-reuse-values` (Helm 3.14+) keeps every value you set and picks up the new chart defaults; a plain `--reuse-values`
  misses the new defaults, and the render can fail. Re-running `single_node_install.sh ... --version <version>` (or `bootstrap.sh` with
  `RAPIDMX_CHART_VERSION`) does the same and also re-checks nginx, the Gateway and the other prerequisites.

The server has no database migrations: on startup it creates and updates its schema from its models
(`datastores.*.synchronize`, the chart's `service.datastores.synchronize`, on by default). That's how an upgrade adds new
collections, tables and columns, but on PostgreSQL TypeORM may drop and recreate a column whose type changed between
releases, losing that column's data. **Back up the database before upgrading.** If you manage schema changes yourself,
set `datastores__acl__synchronize` and `datastores__sql__synchronize` (or `datastores__mongo__synchronize`) to `false`.

**Booking pages moved to a plugin.** The public booking pages (`/book`), Settings → Booking Links and the
`/api/mail/booking-types` and `/api/mail/bookings` APIs are now `@rapidmx/booking-plugin`, one of the default plugins
(`system:plugins:defaults`). An upgraded deployment adds it at its next start, and its existing booking types and
bookings show up again unchanged, since the plugin uses the same collections and tables. `mail:booking:public_url` (the
chart's `mail__booking__public_url`) still sets the address in booking emails; it's also the plugin's setting in the
admin console, and an environment variable wins over the saved value. Until `@rapidmx/booking-plugin` is published to
npm, adding it logs "Could not add default plugin @rapidmx/booking-plugin" at each start, the other plugins install and
load as usual, and booking stays unavailable. To use a local build before then, point `system__plugins__sources` at its
`npm pack` tarball.

### Plugin UI

Plugins can ship pages (for example `@rapidmx/booking-plugin`'s booking pages) and navigation entries along with their
API routes. They ship those pages as TSX sources, so when enabled plugins have UI the server builds the browser bundles
with Vite as it starts, together with its own apps, before it starts serving. The build is kept in
`system:plugins:dir`'s `.ui-build` folder (`/app/plugins/.ui-build` in the image) and reused until the plugins with UI,
their versions, or the server's web client change. Without plugin UI nothing is built and the bundles in the image are
served; the last build is kept, so turning the same plugins back on reuses it.

- **Build time:** the first start after a plugin with UI is added, upgraded, enabled or disabled takes longer, from a few
  seconds on a typical node to about a minute on a small CPU limit. On Kubernetes the plugins volume is per pod, so every
  new pod builds once.
- **Memory:** the build adds a few hundred MiB while it runs, which is why the chart's default memory request and limit
  (`service.resources`) are 512Mi and 1536Mi.
- **Failures never stop the server:** a plugin whose UI fails to build is left out (its pages 404, its navigation entries
  are hidden and the admin console's plugin status shows the error), and the rest are rebuilt without it. A page whose
  path clashes with another plugin's pages or with any other route isn't served either.

## Static Files

The server sends the browser build (`dist/public`: `/assets`, `/fonts`, `/images`, `/styles`, `/favicon.ico`, or the plugin UI
build that replaces it) itself, from `src/routes/BaseStaticAssetRoute.ts`: the right `Content-Type` (WebAssembly included),
`ETag` with `304 Not Modified`, `HEAD`, and brotli/gzip. Fingerprinted bundles (`/assets/<name>-<hash>.js`) get
`Cache-Control: public, max-age=31536000, immutable`, so a browser fetches each one once; other files are cached for an hour
(images, fonts) or revalidated (CSS/JS/HTML). `yarn build` writes `.br` and `.gz` files next to every compressible file
(`scripts/precompress-assets.mjs`), which are sent as they are; a file without them is compressed on first request and kept in
memory. The plugin UI build gets its own at startup. `static_assets:compress`, `static_assets:memory_cache_bytes` and
`static_assets:brotli_quality` configure it (see `config.mongo.ts`).

## Local Development

`yarn dev` runs the server from source with `NODE_ENV=development`, signing every request in as a dev admin user. Mail
can be composed and sent without the scanning stack or an MTA, so neither Docker nor Postfix is required:

- **Spam and virus scanning:** while rspamd or clamd can't be connected to at all (connection refused, a host name that
  doesn't resolve, or a connection timeout), scans are treated as clean and the server logs a `[dev] ... is unreachable`
  warning when it starts bypassing and then at most every five minutes. Start the scanners with
  `docker compose -f docker-compose.mail.yml up -d` to scan for real; once they answer, their verdicts are used again.
- **Sending:** without a `sendmail` binary at `mail:transport:sendmail:path` (default `/usr/sbin/sendmail`), a sent
  message is delivered straight to this server's own mailboxes through the same ingest path Postfix uses, and arrives in
  the recipient's Inbox. Other recipients are rejected, and a message with no local recipient fails to send; relaying
  them needs the [`postfix-bridge`](https://github.com/rapidmx/postfix-bridge) stack.

This only happens with `NODE_ENV` `dev`, `development` or `test`. With any other `NODE_ENV` the real providers are
registered unchanged, and a scanner outage makes every send fail closed.

## Debugging

[Visual Studio Code](https://code.visualstudio.com/) is the recommended IDE to develop with. The project includes workspace and launch configuration files out of the box.

To debug while running via Docker Compose select the `Docker: Attach Debugger` configuration and hit the `F5` key. If you want to run the server directly and debug choose the `Launch Server` configuration.