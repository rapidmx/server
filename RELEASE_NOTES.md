# Release Notes

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
