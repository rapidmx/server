# Release Notes

## Unreleased

## v1.0.0-beta.10

### Features

- **The pages carry the trusted role names (`trustedRoles`, from `trusted_roles`, default `admin`):** the web client's account menu uses them to ask auth-server whether the signed-in user is an administrator - an auth-server token only carries the role once elevated - and shows an "Admin Console" item that only navigates (`/admin` still checks the role and starts the elevation). Needs the next `@rapidmx/web-client`.
- **Static files are sent the way a browser expects:** the browser build (`/assets`, `/fonts`, `/images`, `/styles`, `/favicon.ico`) is
  served by a route of its own with `Content-Type` (with a charset), an `ETag` answered with `304 Not Modified`, `HEAD`, and brotli/gzip.
  `yarn build` now writes `.br` and `.gz` files next to every compressible file (`scripts/precompress-assets.mjs`, 5.6 MiB down to
  1.4 MiB) and the plugin UI build at startup does the same; a file without them is compressed on first request and kept in memory.
  `static_assets:compress`, `static_assets:memory_cache_bytes` and `static_assets:brotli_quality` configure it.
- **Envoy Gateway compresses the API's JSON and the pages' HTML:** the chart attaches a `BackendTrafficPolicy` (brotli, then gzip, from
  1 KiB) to its route. `global.gateway.compression.enabled` is `auto` by default (rendered only when the cluster has Envoy Gateway's
  API), `true` or `false`; it has no effect with `global.gateway.tlsTermination=pod`. The server's own static files already carry
  `Content-Encoding`, which Envoy leaves alone, so nothing is compressed twice.
- **The browser build splits React and the icon set into chunks of their own** (`createServerViteConfig()`'s `codeSplitting` groups `react` and `icons`), on top of the
  web client's own lazy loading: React, React DOM and the scheduler are byte-for-byte the same from one release of the web client to the next, so a returning visitor
  keeps that chunk across deploys (its `Cache-Control` is immutable), and the app's other chunks can change without invalidating it. It replaces one
  1 MB chunk named after an arbitrary module (`MailboxProvisioning-*.js`) and a `client-*.js` holding React DOM and every icon. `strictExecutionOrder` stays on.

### Fixes

- **Live inbox updates, folder-count events and new-mail pop-ups never worked:** `@rapidrest/service-core` creates the publisher every push event goes through
  (`NotificationUtils`) only when a datastore named `notifications` is configured, and none was, so each `sendMessage()` (a delivered message, a changed folder
  count, a delivery-failure notice) silently did nothing, while `/push` kept subscribing on the `events` datastore and the web client waited for events that were
  never sent - new mail needed a page reload. The server now gives `notifications` the same settings as the effective `events` datastore (a deployment's Redis,
  including `datastores__events__*` environment variables) unless a `notifications` datastore is configured explicitly. No chart or values change.
- **The Envoy gateway restarted itself about 40 times a day, and each restart reset every connection** (about 40% of requests failed while it flapped): the
  kubelet probes the `envoy` and `shutdown-manager` containers with a 1 s timeout and kills the pod after three misses, and on a single node whose container
  runtime stalls for a few seconds now and then that is not enough. `single_node_install.sh` (both gateway modes) and `deploy/aws/bootstrap.sh` now give the
  EnvoyProxy an `envoyDeployment` strategic-merge patch with 5 s probe timeouts and 6 allowed failures. To fix an existing host without reinstalling, patch its
  EnvoyProxy (`kubectl -n envoy-gateway-system patch envoyproxy <name> --type merge --patch-file ...`, the same JSON the installers render); Envoy Gateway rolls the pod.

- **Without OpenBao the server and the auth-server didn't share a JWT secret,** so every sign-in was refused: `single_node_install.sh --openbao false` and
  `deploy/aws` (`RAPIDMX_OPENBAO=false`) passed the secret as `global.authSecret`, which no chart reads (the value is `global.jwt.secret`), so each chart generated its own.
  Both now pass `global.jwt.secret`, and so do the chart's notes and the README, which also describes each way to deploy in full.
- **Every page load downloaded the whole web client again (about 2.5 MB):** the bundles were sent with no `Cache-Control`, no validator
  and no compression, so the mail app fetched all ~20 chunks on every folder change and app switch (each one is a full page load).
  Fingerprinted bundles (`/assets/<name>-<hash>.js|css|wasm`) are now `Cache-Control: public, max-age=31536000, immutable` and fetched
  once; a cold inbox load is 0.57 MB with brotli instead of 2.5 MB, and a repeat visit fetches only the page itself. Images and fonts are
  cached for an hour, CSS/JS/HTML that isn't fingerprinted is revalidated (`304`).
- **The local search index's WebAssembly file returned 404:** `.wasm` wasn't a file type the pages' file serving knew, so
  `/assets/wa-sqlite-async-*.wasm` answered with an HTML 404 page. It is served (`application/wasm`, brotli 2.2 MiB to 0.6 MiB).
- **`HEAD` on a static file (`curl -I`) answered 404 with `Content-Length: 9223372036854775808`:** it now answers the real headers and
  length. (`HEAD /` and other pages still do; that is in `@rapidrest/react` and `@rapidrest/service-core`, see `.claude/NOTES.md`.)
- Rate limits audited, no change needed: only the few `@RateLimit()` endpoints (key discovery and lookup, directory and GIF search,
  the booking plugin's public calls) are counted; page loads, `/assets/*`, `/push` and the mail CRUD calls never are.

## v1.0.0-beta.9

## v1.0.0-beta.8

### Fixes

- **Sign-out did not sign out of the auth-server, and sign-in never returned to the mail app:** the chart wrote every allowed
  browser origin twice-quoted (`["\"https://mail.example.com\""]`, a regression from `c80ca7f`), so neither service matched any
  origin - the browser blocked the mail app's cross-origin logout, profile and username calls, and the auth-server dropped
  every `return_to` it was given. Origins are plain again, and `global.corsHosts` now lists `mail.<domain>` and `auth.<domain>`
  by default (the auth-server reads this list too, and it had never contained the mail host). `single_node_install.sh` and
  `deploy/aws/bootstrap.sh` pass the real `--mail-host`/`--auth-host` names as `global.corsHosts`. Needs an auth-server chart
  with the same one-word fix (its `service-config.yaml` had the same bug).
- **Replies to external addresses vanished:** Postfix routed every recipient through postfix-bridge, which handed the message
  back to the server, which dropped it. Fixed in the postfix-bridge chart (`relay_transport` instead of a static
  `transport_maps`); needs that chart's new release, then `helm upgrade`.
- **"No mailbox available" for every account:** `@rapidmx/restapi` asked the auth-server for a user's names at an endpoint that
  doesn't exist. Fixed in `@rapidmx/restapi`.
- Web client fixes shipped with `@rapidmx/react-shared` and `@rapidmx/web-client`: the admin console sends an admin without an
  elevated token to the auth-server's `/auth/elevate` page and back, DNS records have copy buttons, the admin console no longer
  shows the custom header, the account menu shows the profile name (else the username) and an Account link, sender addresses are
  always visible, new mail appears without a refresh, and a failed send shows the mail system's own error.

## v1.0.0-beta.7

## v1.0.0-beta.6

### Fixes

- **`helm lint` failed on a fresh checkout,** and so did CI: the server's URL to the auth-server (`mail__auth_server_url`) read `authserver.host`, which is only set once the auth-server subchart is in `helm/charts/` (its tarballs are git-ignored), and failed with "wrong type for value; expected string; got interface {}" without it. It now falls back to `auth.<global.domain>`, the same default the JWT issuer uses.

## v1.0.0-beta.5

### Features

- **`single_node_install.sh --gateway shared|chart`:** `shared` (the default) has the script create one Gateway,
  `envoy-gateway-system/shared-gateway`, with an HTTPS listener per host that the chart's routes attach to; `chart` has
  the chart create a Gateway for each of its hosts, which the script merges into one Envoy Service for nginx. Both get
  Let's Encrypt certificates through cert-manager, and re-running the script switches between them.
- **A Gateway the chart doesn't create can terminate TLS:** with `global.gateway.name` and `global.gateway.namespace` set,
  the chart's routes attach to every listener of that Gateway that accepts the host, and the chart renders the
  ReferenceGrant that lets it read each `<host>-tls-cert` Secret.
- **The auth-server's e-mail (sign-in and verification codes) is configured:** `global.smtp` (host, port, secure, ignoreTLS,
  requireTLS, from) feeds the auth-server's `smtp_config` and `templates.from.email`. The default is the bundled Postfix
  over the cluster network (host `postfix`, port 25, TLS off for that hop because Postfix's certificate is for its public host
  name), from `noreply@<global.domain>`; the auth-server can only send over SMTP, so on AWS `deploy/aws/bootstrap.sh` points it
  at SES's SMTP endpoint with `RAPIDMX_SES_SMTP_USERNAME`/`RAPIDMX_SES_SMTP_PASSWORD` (kept in a Secret, read through the
  new `authserver.service.extraEnv`) and leaves e-mail unconfigured without them. Needs an auth-server image and chart
  with `nodemailer` and `service.extraEnv`; earlier ones ignore `extraEnv` and fail every send with a missing `nodemailer`.

### Fixes

- **Postfix and postfix-bridge are installed again:** `postfixBridge.create` had been switched off. Postfix's certificate
  comes from the release's own Issuer (`postfixBridge.tls.certManager.issuerName`/`issuerKind` default to it, not to a
  `letsencrypt-prod` ClusterIssuer that only exists where someone made one), and `single_node_install.sh` has it present the
  server's own `<host>-tls-cert` rather than issuing a second certificate for the same name.
- **Nobody could sign in:** the server expected tokens issued by the mail host (`global.jwt.issuer` resolved to `host` in this
  chart) while the auth-server signs them as itself, so every token was refused; both sides use the auth-server's host, as
  in 1.0.0-beta.4. With OpenBao the auth-server also never got its default admin account: External Secrets replaced the whole
  `service-secrets` Secret and dropped `default_accounts`, so it now merges its keys into the Secret the chart renders.
- **The server could not send mail at all:** the chart's `command: ["node"]` replaced the image's entrypoint, which is what writes
  msmtp's config, so `sendmail` failed with "no configuration file available"; the container now gets `args` only, as the chart's own
  comment said.
- **The domain DNS-setup page never found the MX record:** the chart didn't set `mail__dns__mx_hostname`; it defaults to
  `mail.mxHostname` or Postfix's host name.
- **Inbound mail was quarantined:** `service.config` no longer pointed the server at the rspamd and ClamAV Services, so both
  scanners defaulted to localhost, and an unreachable scanner quarantines the message.
- **`service.host` is `host` again** in the places that still read the old name (the sender address of outbound mail and the
  check that Postfix is configured), so a plain `helm install` no longer sends from `mailer@null`.
- **Postfix must run with the postfix-bridge chart that sets `postfix.externalTrafficPolicy: Local`** (released after 1.2.0).
  Behind k3s' ServiceLB every internet client otherwise looks like an internal address, which Postfix trusts, so it relays for
  anyone using one of your domains as the sender. Nothing was relayed while testing, but do not expose port 25 with 1.2.0.
- **deploy/aws** no longer creates a `letsencrypt-prod` ClusterIssuer (the chart issues its certificates from its own Issuer,
  registered with `RAPIDMX_ACME_EMAIL`), passes the chart the values it reads now (`global.gateway.*`, `host`; it still passed
  `gateway.*` and `service.host`, so the chart never used the shared Gateway) and unseals OpenBao with the key as an argument.
- **A domain added in the admin console now works at once,** without restarting Postfix, re-running the installer or upgrading the release: Postfix accepts mail for
  it, lets the server send as it and signs its mail with the DKIM key the console shows (previously the sender allow-list and OpenDKIM's keys were fixed when Postfix started,
  so a new domain could not send, and the first domain signed with a key nobody had published, until Postfix was restarted). Needs the postfix-bridge chart with this change;
  `postfixBridge.domains` / `--mail-domains` is now only the set Postfix knows at start.
- **"mail.trustedAuthservId is empty" after every install, and setting it did nothing:** the value was only read by the install
  warning, never passed to the server (`mail__security__trusted_authserv_id`). It now is, and with the bundled Postfix it defaults
  to Postfix's host name, the authserv-id its OpenDKIM stamps, so no sender is left unverified and the warning appears only when
  there is no bundled Postfix and no id set. This needs the postfix-bridge chart that fixes OpenDKIM's key lookups: before
  it, OpenDKIM could not fetch any DKIM key and never stamped a passing result.
- **cert-manager Issuers were never created,** because `global.certmanager.name` defaulted to `<fullname>-letsencrypt` while
  the chart only created an Issuer named `<fullname>-issuer`; the default is now `-issuer`. The Issuer manifest was
  also mis-indented, so it wouldn't have applied, and `issuerRef` carried a `namespace` cert-manager rejects.
- **The vault-managed secrets were incomplete:** the mail ingest secret and the escrow audit key were missing from the
  ExternalSecrets, so the server pod never started with `global.openbao.enabled`.
- **single_node_install.sh** passed values the chart no longer reads (`gateway.*`), never created a Gateway, waited for
  a port 443 that only exists once the certificates do, and only listened on IPv4 for hosts with AAAA records, which
  Let's Encrypt tries first. Its OpenBao unseal and the unsealer Deployment passed the key as `-`, which OpenBao takes
  literally.

## v1.0.0-beta.4

### Breaking changes

- **`host` is now `service.host`, derived from the new `global.domain`.** Set `global.domain` to the mail domain
  (`example.com`): the server is served at `mail.<domain>`, and Postfix HELOs as that name and sends mail for
  `<domain>`. `service.host` overrides the name itself, and the render fails with a pointer while the old `host` value
  is still set. `authserver.host` still has to be set explicitly (`auth.<domain>`), because the auth-server subchart
  reads its own `host` without rendering templates.
- **JWT audience and issuer are now the domain and the auth-server host** (previously `mail-server-api` on both sides),
  so everyone signs in again after this upgrade - existing tokens no longer verify.
- **`global.mailIngestSecret` replaces `mail.ingestSecret` as the required secret.** It's shared by the server and the
  bundled postfix-bridge; `mail.ingestSecret` now defaults to it. An install that only sets `mail.ingestSecret` fails to
  render until `global.mailIngestSecret` is set to the same value.
- **Postfix and postfix-bridge are installed with the chart** (the `postfixBridge` dependency, postfix-bridge 1.1.0). A
  release that installed the postfix-bridge chart separately gets a second Postfix: uninstall that release, or set
  `postfixBridge.create=false`.

### Features

- **OpenBao as the secret vault** (`global.openbao.enabled`, off in the chart, on in the install scripts): the JWT, cookie, session, escrow audit and
  ingest secrets live in OpenBao, along with the certificate authority for end-to-end encrypted mail
  (`mail:pki:backend=openbao`, a PKI mount and an issuing role), and External Secrets copies the values into the
  Kubernetes Secrets the pods load, so no application change was needed. The bundled auth-server reads the same vault
  path (`global.openbao`), so both ends share one JWT secret and neither `global.authSecret` nor
  `global.mailIngestSecret` has to be supplied. **OpenBao and External Secrets are prerequisites, like cert-manager -
  the chart installs neither.** `single_node_install.sh --openbao true` and `deploy/aws` (`RAPIDMX_OPENBAO`, the
  `EnableOpenBao` stack parameter) install and initialise the vault, keep its unseal key in a Secret with an unsealer
  Deployment that re-unseals it after any restart, write each secret once (upgrades never re-key them), set up the PKI
  mount and role, and create the tokens the chart reads. Point `global.openbao.address` at a vault you already run to
  use that one instead - with `global.openbao.auth.method=kubernetes` it authenticates with the pod's ServiceAccount and
  stores no token. The chart itself defaults the value to false, so a `helm install` that doesn't opt in behaves exactly
  as before.
- **AWS deployments:** `mail.transport.provider=ses` sends outbound mail through AWS SES (`SesMailTransport`, region
  from `mail.transport.ses.region`) instead of Postfix, for a deployment receiving through
  [`ses-bridge`](https://github.com/rapidmx/ses-bridge); the render refuses SES together with the bundled Postfix.
  `serviceAccount.create` with an `eks.amazonaws.com/role-arn` annotation gives the pod an AWS role (IRSA), and
  `mail.ingestService.enabled` adds an internal load balancer for `/internal/mta` so ses-bridge's Lambda can reach it
  from inside the VPC (the public Gateway still answers 404 there), restricted with
  `mail.ingestService.loadBalancerSourceRanges`.
- **AWS deployment in `deploy/aws/`:** a CloudFormation template (network, IAM role, security group, EC2 instance,
  optional Route 53 records) whose user data runs `bootstrap.sh`: k3s with the AWS cloud controller and EBS CSI driver,
  Envoy Gateway behind a Classic Load Balancer that forwards TCP with the PROXY protocol, cert-manager, and this chart
  with SES for mail. `single_node_install.sh` stays the bare-metal installer.
- **Bundled mail transport:** with a public `host`, set `postfixBridge.hostname` (Postfix's MX host name) and
  `postfixBridge.domains` (the domains it sends mail for); the render fails while they're still the placeholders.
  Postfix signs with the DKIM keys the server writes to its `mail.dkim.storage` volume, so with `ReadWriteOnce` storage
  both pods run on the same node. Without cert-manager, `postfixBridge.tls.certManager.enabled=false` self-signs
  Postfix's certificate.
- **single_node_install.sh** installs Postfix too: `--mail-domains` sets the domains it sends mail for (default
  `--domain`), port 25 is opened in ufw or firewalld, and `--tls false` works with a public domain (Postfix gets a
  self-signed certificate).

### Fixes

- **Helm values comments:** the 1.0.0-beta.3 release tool stripped every comment from `helm/values.yaml`; they're back.
- **README:** the compose section's loopback address read `1.0.0-beta.3.1` instead of `127.0.0.1`.

## v1.0.0-beta.3

A reference implementation of a RapidMX mail server, providing a complete, deployable mail service that includes a web mail (React) client as well as Exchange ActiveSync, and MAPI support.
