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
| Tag          | 1.0.0-beta.4 |

This project provides scripts for running in Docker or Kubernetes. For Docker, you will find *docker-compose* scripts
in the project source. For Kubernetes, a *helm* chart is available both in the project source and via GitHub Container
Registry (ghcr.io).

### Docker Compose

Pick `docker-compose.mongo.yml` or `docker-compose.sql.yml` depending on which datastore backend you want
(MongoDB or PostgreSQL) — there is no plain `docker-compose.yml`. Either one, on its own, brings up this
service, the separate [`auth-server`](https://github.com/rapidrest/auth-server) deployment it verifies
JWTs against, and rspamd/ClamAV for inbound spam/AV scanning — but *not* real inbound/outbound mail
transport. That's provided by the separate [`postfix-bridge`](https://github.com/rapidmx/postfix-bridge)
repo (Postfix + DKIM signing + the bridge that lets Postfix's own recipient/domain lookups and final
delivery talk to this app's `/internal/mta` contract) — run its own `docker compose up` alongside this
one, not instead of it; see that repo's README for its own compose file and env vars.

```bash
docker compose -f docker-compose.mongo.yml up -d --build
```

`auth-server`'s image (`ghcr.io/rapidrest/auth-server`) is pulled from GHCR, not built locally.

These compose files are for local evaluation: they run with `NODE_ENV=dev` and publish every port on the host's
loopback address (`1.0.0-beta.4.1`) only. For anything beyond that, set `NODE_ENV=production` and override these in a
`.env` file next to the compose files (every secret defaults to an insecure, publicly-known placeholder value
otherwise — see `src/config.defaults.ts`; the server refuses to start with those unless `NODE_ENV` is `dev`,
`development` or `test`):

| Variable | Purpose |
| --- | --- |
| `AUTH_SECRET` | JWT signing secret — must match between this service and `auth-server` exactly |
| `AUTH_AUDIENCE` / `AUTH_ISSUER` | JWT `aud`/`iss` claims — must also match `auth-server` |
| `AUTH_SERVER_PUBLIC_URL` | Browser-facing base URL of `auth-server` (defaults to `http://localhost:3001`, dev/single-host only) |
| `COOKIE_SECRET` | Shared cookie-signing secret |
| `ESCROW_AUDIT_HMAC_KEY` | Key for the escrow audit log's HMAC-SHA256 hash chain (`mail:escrow:audit_hmac_key`) — generate once (`openssl rand -hex 32`) and never change it; unset, entries are chained with unkeyed SHA-256 and the server logs an error in production |
| `MAIL_INGEST_SECRET` | Bearer secret authenticating `postfix-bridge`'s calls to this app's `/internal/mta` routes — must match that repo's own `MTA_INGEST_SECRET` exactly |
| `PUBLIC_URL` | This deployment's public base URL (defaults to `http://localhost:3000`) — the booking plugin's email links and the autodiscover plugin (which requires `https://`) |
| `MX_HOSTNAME` | Public MX hostname (defaults to `localhost`) — outgoing read receipts and domain DNS checks |
| `SENDMAIL_RELAY_HOST` / `_PORT` / `_TLS` | Where `PostfixSendmailTransport` relays outbound mail — defaults to `host.docker.internal:25` (TLS off), i.e. wherever the separate `postfix-bridge` stack publishes its own Postfix on the host's `localhost:25`; override for anything beyond local, single-host evaluation |

The `dkim_rspamd_keys`/`mongo_data`/`postgres_data`/`blob_data` named volumes persist DKIM keys, database
contents, and message/attachment storage across `docker compose down`/`up` — don't remove them (`docker
compose down -v`) unless you actually want to start over. `dkim_rspamd_keys` in particular needs to be
shared with the `postfix-bridge` repo's own compose stack (its Postfix reads DKIM keys this app's
`FsDkimKeyProvider` writes) — point both stacks at the same underlying volume for that to work outside of
local single-host evaluation; see that repo's own README.

**Mail transport security** (Postfix's TLS posture, the `postfix-bridge` hop, DKIM/DMARC) is documented in
the [`postfix-bridge`](https://github.com/rapidmx/postfix-bridge) repo's own README now that it owns
Postfix. The one thing that lives on this side: `server` → Postfix (`PostfixSendmailTransport`/msmtp) is
unencrypted by default (`SENDMAIL_RELAY_TLS`, defaulting to `off`), since that hop is internal to the
compose network.

### Kubernetes

A complete Helm chart is included for convenience to deploy and run on a Kubernetes cluster. Deployment to Kubernetes
is easy using either the published helm chart in GitHub or install from the helm chart locally. Real inbound/outbound
mail transport (Postfix, DKIM signing and [`postfix-bridge`](https://github.com/rapidmx/postfix-bridge)) is the
`postfixBridge` dependency, installed with the chart. With a public `host`, set `postfixBridge.hostname` (Postfix's MX
host name, which gets a Let's Encrypt certificate from cert-manager's `letsencrypt-prod` ClusterIssuer) and
`postfixBridge.domains` (the comma-separated domains it sends mail for); the render fails while they're the
placeholders. Without cert-manager, set `postfixBridge.tls.certManager.enabled=false` for a self-signed certificate, or
`postfixBridge.tls.existingSecret` to your own. Postfix signs mail with the DKIM keys the server writes to its
`mail.dkim.storage` volume, so with the default `ReadWriteOnce` both pods must run on the same node. Set `postfixBridge.create=false` to install postfix-bridge as its
own release instead; the release notes (`helm get notes`) then say how to connect it.

On AWS, set `mail.transport.provider=ses` with `postfixBridge.create=false` to send through SES instead of Postfix
(`mail.transport.ses.region`, and inbound mail through [`ses-bridge`](https://github.com/rapidmx/ses-bridge)); the render
fails if both are on at once. The pod gets its AWS credentials from `serviceAccount.create` with an
`eks.amazonaws.com/role-arn` annotation (IRSA) or from the node's own role, and `mail.ingestService.enabled` adds an
internal load balancer for `/internal/mta`, which ses-bridge's Lambda calls from inside the VPC - the public Gateway
still answers 404 for `/internal`. Restrict it with `mail.ingestService.loadBalancerSourceRanges`.

Set `global.domain` to the deployment's mail domain (e.g. `example.com`): mail is addressed `@<domain>`, the server is
served at `service.host` (`mail.<domain>` by default), the auth-server at `authserver.host` (set it to `auth.<domain>` —
it can't default to a template, because the auth-server subchart reads its own `host` literally), and the JWT audience
and issuer are the domain and that auth host on both sides. Postfix's MX name and sender domains follow the same value.

#### Secrets and OpenBao

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

The chart needs two secrets you supply, and refuses to render without them: `global.authSecret` (the JWT secret, shared
with the bundled auth-server) and `global.mailIngestSecret` (shared with postfix-bridge). Pass the same values
again on every upgrade. Cookie, session and escrow audit (`mail.escrow.auditHmacKey`) secrets are generated on install and
kept - which needs cluster access, so rendering the chart without it (`helm template`, Argo CD/Flux, `--dry-run`) fails
until you set `cookies.secret`, `sessions.secret` and `mail.escrow.auditHmacKey` explicitly or point
`secrets.existingSecret` at a Secret you manage. Outbound mail is relayed to postfix-bridge's `postfix`
Service (`mail.relay.*`). Behind a Gateway this chart doesn't create, set `gateway.httpsListener` to the listener that
terminates TLS for `host` with the `<host>-tls-cert` Secret (the render fails without it while `gateway.tls` is
true; set `gateway.tls=false` to serve plain HTTP). The usual naming is `host: mail.<domain>` with
`authserver.host: auth.<domain>` - with a public `host`, set `authserver.host`,
the auth-server's public name that sign-in redirects to; on someone else's Gateway also set `authserver.gateway.name`
and `authserver.gateway.namespace` to that Gateway and `gateway.authHttpsListener` to its HTTPS listener for that host
(the render fails while these don't line up). Set `mail.trustedAuthservId` to the authserv-id your inbound MTA stamps:
while it's empty no sender is DKIM-verified, so members-only distribution lists drop all mail, list and forward-rule
copies get a rewritten From, and forwarded invites are refused. `/api/metrics`
requires a token with a trusted role, so scrape it with a bearer token rather than `prometheus.io/*` annotations.

#### From GHCR

```bash
helm upgrade --install --create-namespace --namespace rapidmx rapidmx oci://ghcr.io/rapidmx/charts/server --version 1.0.0-beta.4   --set global.jwt.secret="$(openssl rand -hex 32)" --set global.mailIngestSecret="$(openssl rand -hex 32)"   --set global.domain=example.com
```

#### From Local

```bash
helm repo add bitnami https://charts.bitnami.com/bitnami
helm dep up ./helm
helm upgrade --install --create-namespace --namespace rapidmx rapidmx ./helm --set global.jwt.secret="$(openssl rand -hex 32)" --set global.mailIngestSecret="$(openssl rand -hex 32)"
```

The chart runs one replica by default, because its message, DKIM and PKI volumes are `ReadWriteOnce`. To run more,
use `mail.blob.backend: s3` (or `ReadWriteMany` storage) and `ReadWriteMany` for `mail.dkim.storage` and
`mail.pki.storage`.

#### Upgrading

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

#### Plugin UI

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

#### Single Node Cluster

If you would like to run the project in a single-node Kubernetes cluster, the `single_node_install.sh` script is a
great way to get started. This script will automatically set up everything needed to run *server* in a Kubernetes
environment, including ingress with TLS support. Simply run the script from any linux compatible machine.

```bash
./single_node_install.sh --domain mail.example.com --email admin@example.com
```

It installs k3s, helm, [Envoy Gateway](https://gateway.envoyproxy.io/) (a shared Gateway `envoy-gateway-system/shared-gateway`
whose Service is only reachable inside the cluster), nginx on the host forwarding ports 80 and 443 to that Gateway with
the PROXY protocol (so the server sees real client addresses), cert-manager with a Let's Encrypt `letsencrypt-prod`
ClusterIssuer, and this chart. `--domain` is the mail domain (e.g. `example.com`): the server is served at
`mail.<domain>`, the auth-server at `auth.<domain>`, and mail is addressed `@<domain>`. `--mail-host` and `--auth-host`
change those two names, as a label (`--mail-host rapidmx` gives `rapidmx.<domain>`) or a whole host name. Postfix
listens on port 25 (through k3s' ServiceLB) as the server's host name and sends mail for
`--mail-domains` (default `<domain>`). Both host names must resolve to the machine, and your mail domains' MX records
point at `mail.<domain>`. With `--tls false` Postfix gets a
self-signed certificate. When a host firewall is active (ufw
on Ubuntu/Debian, firewalld on RHEL/Fedora) it opens SMTP/HTTP/HTTPS and allows k3s' pod and service networks; under SELinux it also allows nginx to relay. Set `CHART=./helm` to install the chart from a checkout instead of the published one, and
`ENVOY_GATEWAY_VERSION` to pick another Envoy Gateway release. `--uninstall` removes only what the script installed.

#### AWS

`deploy/aws/` deploys the same stack on AWS instead: one CloudFormation template that creates the network, IAM role and
EC2 instance, whose user data runs `deploy/aws/bootstrap.sh`. See [deploy/aws/README.md](deploy/aws/README.md).

```bash
aws cloudformation deploy --stack-name rapidmx --template-file deploy/aws/rapidmx-server.yaml \
  --capabilities CAPABILITY_IAM --parameter-overrides Domain=mail.example.com HostedZoneId=Z123EXAMPLE
```

There is no nginx there: Envoy's Service is a Classic Load Balancer forwarding TCP with the PROXY protocol, Envoy still
terminates TLS, volumes are EBS, and mail goes through SES
([`ses-bridge`](https://github.com/rapidmx/ses-bridge)) rather than Postfix.

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