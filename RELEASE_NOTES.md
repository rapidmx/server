# Release Notes

## Unreleased

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
