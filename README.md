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
| Tag          | 1.0.0-beta.2 |

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
loopback address (`127.0.0.1`) only. For anything beyond that, set `NODE_ENV=production` and override these in a
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
| `PUBLIC_URL` | This deployment's public base URL (defaults to `http://localhost:3000`) — booking email links and the autodiscover plugin (which requires `https://`) |
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
mail transport (Postfix + DKIM signing + postfix-bridge) is a separate chart now — install
[`postfix-bridge`](https://github.com/rapidmx/postfix-bridge) alongside this one; see its own README and this chart's
`helm get notes` output for how the two are wired together (`mail.ingestSecret` must match on both sides).

The chart needs two secrets you supply, and refuses to render without them: `global.authSecret` (the JWT secret, shared
with the bundled auth-server) and `mail.ingestSecret` (must match the `postfix-bridge` chart's). Pass the same values
again on every upgrade. Cookie, session and escrow audit (`mail.escrow.auditHmacKey`) secrets are generated on install and
kept - which needs cluster access, so rendering the chart without it (`helm template`, Argo CD/Flux, `--dry-run`) fails
until you set `cookies.secret`, `sessions.secret` and `mail.escrow.auditHmacKey` explicitly or point
`secrets.existingSecret` at a Secret you manage. Outbound mail is relayed to the `postfix-bridge` chart's `postfix`
Service (`mail.relay.*`). Behind a Gateway this chart doesn't create, set `gateway.httpsListener` to the listener that
terminates TLS for `host` with the `<host>-tls-cert` Secret (the render fails without it while `gateway.tls` is
true; set `gateway.tls=false` to serve plain HTTP). With a public `host`, set `authServer.host` (e.g. `auth.<host>`),
the auth-server's public name that sign-in redirects to; on someone else's Gateway also set `authServer.gateway.name`
and `authServer.gateway.namespace` to that Gateway and `gateway.authHttpsListener` to its HTTPS listener for that host
(the render fails while these don't line up). Set `mail.trustedAuthservId` to the authserv-id your inbound MTA stamps:
while it's empty no sender is DKIM-verified, so members-only distribution lists drop all mail, list and forward-rule
copies get a rewritten From, and forwarded invites are refused. `/api/metrics`
requires a token with a trusted role, so scrape it with a bearer token rather than `prometheus.io/*` annotations.

#### From GHCR

```bash
helm install --create-namespace --namespace mail-server mail-server oci://ghcr.io/rapidmx/charts/server --version 1.0.0-beta.2   --set global.authSecret="$(openssl rand -hex 32)" --set mail.ingestSecret="$(openssl rand -hex 32)"
```

#### From Local

```bash
helm repo add bitnami https://charts.bitnami.com/bitnami
helm dep up ./helm
helm install --create-namespace --namespace mail-server mail-server ./helm   --set global.authSecret="$(openssl rand -hex 32)" --set mail.ingestSecret="$(openssl rand -hex 32)"
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

#### Single Node Cluster

If you would like to run the project in a single-node Kubernetes cluster, the `single_node_install.sh` script is a
great way to get started. This script will automatically set up everything needed to run *server* in a Kubernetes
environment, including ingress with TLS support. Simply run the script from any linux compatible machine.

```bash
./single_node_install.sh
```

## Debugging

[Visual Studio Code](https://code.visualstudio.com/) is the recommended IDE to develop with. The project includes workspace and launch configuration files out of the box.

To debug while running via Docker Compose select the `Docker: Attach Debugger` configuration and hit the `F5` key. If you want to run the server directly and debug choose the `Launch Server` configuration.