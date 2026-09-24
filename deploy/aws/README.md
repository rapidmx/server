# RapidMX server on AWS

One CloudFormation stack, one EC2 instance, one command. The template creates the network (or uses yours), an IAM role,
a security group and the instance; the instance's user data downloads `bootstrap.sh` and installs everything:

- **k3s**, without its own ServiceLB and in-tree cloud controller;
- **aws-cloud-controller-manager**, so Kubernetes Services of type LoadBalancer become **Classic Load Balancers**, and
  **aws-ebs-csi-driver** with a `gp3` StorageClass, so volumes are **EBS**;
- **Envoy Gateway**, whose Envoy Service is a Classic Load Balancer forwarding TCP with the **PROXY protocol** (Envoy
  still terminates TLS itself, and the server still sees each client's real address);
- **cert-manager**, whose Let's Encrypt certificates the chart issues from its own Issuer (registered with `RAPIDMX_ACME_EMAIL`);
- the **RapidMX server chart** (webmail, auth-server, MongoDB, Redis, rspamd, ClamAV), sending mail through **SES**
  rather than Postfix.

```bash
aws cloudformation deploy --stack-name rapidmx \
  --template-file rapidmx-server.yaml --capabilities CAPABILITY_IAM \
  --parameter-overrides Domain=example.com HostedZoneId=Z123EXAMPLE
```

`aws cloudformation describe-stacks --stack-name rapidmx --query 'Stacks[0].Outputs'` then prints the addresses and the
command that shows the install summary (load balancer name, generated secrets, the ses-bridge command) over Session
Manager. The stack only reports success once the whole install finished, so a failed install fails the stack.

## Parameters

| Parameter | Default | Notes |
| --- | --- | --- |
| `Domain` | *(required)* | The mail domain, e.g. `example.com`. The server is served at `<MailHost>.<domain>`, sign-in at `<AuthHost>.<domain>` (both CNAMEs to the load balancer), and mail is addressed `@<domain>`. |
| `MailHost` / `AuthHost` | `mail` / `auth` | The two host labels within the domain. |
| `AcmeEmail` | `admin@<domain>` | Let's Encrypt account address. |
| `HostedZoneId` | *(none)* | A Route 53 zone for `<domain>`, which the instance writes the `mail` and `auth` records into, so certificates are issued on first boot. Without it, create those records yourself. |
| `ChartVersion` | `1.0.0-beta.3` | The published chart version to install. |
| `InstanceType` | `t3.large` | Everything runs on this one instance; 8 GiB of memory is the practical minimum. |
| `VolumeSize` | `60` | Root volume (GiB). Message, DKIM and PKI storage are separate EBS volumes. |
| `KeyName` | *(none)* | Optional SSH key. Session Manager works without one. |
| `VpcId` / `SubnetId` | *(none)* | An existing public subnet to launch into. Left empty, the stack creates a VPC, public subnet and internet gateway with the tags the cloud controller needs. |
| `AllowedWebCidr` | `0.0.0.0/0` | Who may reach HTTP/HTTPS, applied to the load balancer. |
| `AllowedSshCidr` | *(none)* | Opens port 22 when set. Empty opens no SSH at all. |
| `ClusterName` | `rapidmx` | The `kubernetes.io/cluster/<name>` tag the cloud controller identifies this cluster's resources by. |
| `BootstrapUrl` | this repo's `deploy/aws/bootstrap.sh` on `main` | The install script the instance runs. Pin it to a release tag once one contains `deploy/aws`, so a stack installs a fixed version. |

## Prerequisites and limits

- **Bring your own VPC:** its subnet must be public and tagged `kubernetes.io/role/elb=1` and
  `kubernetes.io/cluster/<ClusterName>`, and the VPC needs DNS host names enabled. The stack's own network has all of
  this already.
- **DNS:** without `HostedZoneId`, certificates stay pending (plain HTTP serves meanwhile) until you point
  `mail.<domain>` and `auth.<domain>` at the load balancer. `MailHost`/`AuthHost` change those two names.
- **Mail:** outbound goes through SES with the instance's role, so the sending domain must be a verified SES identity,
  and the account may still be in the SES sandbox. Inbound needs [`ses-bridge`](https://github.com/rapidmx/ses-bridge)
  deployed per mail domain, with its Lambda in this VPC so it can reach the internal `/internal/mta` load balancer this
  stack creates (the public Gateway answers 404 for `/internal`). The summary prints the exact deploy command.
- **Signing certificates need `ses-bridge` too.** With a real `MailDomain` the chart's `mail.signingEnrollment.backend`
  defaults to automated RFC 8823 issuance, which requires a certificate authority's verification e-mail to actually
  reach the mailbox and the mailbox's own reply to go back out DKIM-signed - both only work once `ses-bridge` is
  deployed and delivering inbound mail. Until then, a signing-certificate request stalls at "awaiting challenge"
  (visible on the Signing Certificates admin page and `GET /api/system/signing-enrollment`'s `health`); it starts
  moving once `ses-bridge` is in place. Set `mail.signingEnrollment.backend: manual` instead if you'd rather an
  administrator upload certificates by hand until `ses-bridge` is deployed.
- **The auth-server's e-mail:** it can only send its sign-in and verification codes over SMTP, which can't use the instance's
  role, so set `RAPIDMX_SES_SMTP_USERNAME` and `RAPIDMX_SES_SMTP_PASSWORD` (an SES SMTP account, from the SES console's SMTP
  settings) for it to send through `email-smtp.<region>.amazonaws.com` as `RAPIDMX_MAIL_FROM` (default `noreply@<domain>`, which
  must be a verified SES identity). Without them its e-mail stays unconfigured and the summary says so. The stack has no
  parameter for them, so that a password isn't kept in the instance's user data: re-run `bootstrap.sh` on the instance with
  them set (see below).
- **Video calls:** the chart's bundled TURN server (coturn, which relays a call's media for a participant behind a strict
  firewall) is switched off here. It listens on the node's own address and needs UDP open to the internet on an address that
  doesn't change; this instance's public address is not fixed, and the load balancer in front of the site carries only TCP.
  Calls still connect directly between participants and through public STUN servers, which covers most networks. To add
  TURN, give the instance an Elastic IP, open TCP and UDP 3478 and UDP 49152-49252 to it in the security group, and
  re-run `bootstrap.sh`'s `helm upgrade` with `--set coturn.create=true --set coturn.hostname=<that address>
  --set coturn.externalIp=<that address>`, or run your own TURN server and set the Video Conferencing plugin's TURN
  settings in the admin console.
- **One instance, no HA:** a single k3s node with `ReadWriteOnce` EBS volumes. Back up the database before upgrading —
  the server creates and updates its schema at startup, with no migrations.

## Running `bootstrap.sh` yourself

The script only needs an EC2 instance with the same IAM role and tags; everything else comes from environment
variables, and it reads nothing from stdin:

```bash
RAPIDMX_DOMAIN=example.com RAPIDMX_HOSTED_ZONE_ID=Z123EXAMPLE \
  bash <(curl -fsSL https://raw.githubusercontent.com/rapidmx/server/main/deploy/aws/bootstrap.sh)
```

`RAPIDMX_MAIL_HOST`, `RAPIDMX_AUTH_HOST` (a label or a whole host name), `RAPIDMX_TLS`, `RAPIDMX_NAMESPACE`, `RAPIDMX_CHART`,
`RAPIDMX_CHART_VERSION`, `RAPIDMX_AUTH_SECRET`,
`RAPIDMX_INGEST_SECRET`, `RAPIDMX_INGEST_CIDRS`, `RAPIDMX_WEB_CIDRS`, `RAPIDMX_SES_REGION`, `RAPIDMX_SES_SMTP_USERNAME`, `RAPIDMX_SES_SMTP_PASSWORD`, `RAPIDMX_MAIL_FROM`, `RAPIDMX_STORAGE_CLASS`,
`RAPIDMX_CLUSTER_NAME`, `RAPIDMX_OPENBAO`, `RAPIDMX_OPENBAO_ADDRESS` and `ENVOY_GATEWAY_VERSION` are the rest; see the
comment at the top of the script. Re-running it keeps the release's existing secrets.

## Secrets and OpenBao

The stack's `EnableOpenBao` parameter (`RAPIDMX_OPENBAO`, on by default) installs [OpenBao](https://openbao.org) in the
cluster and keeps the deployment's secrets in it - the JWT secret shared with the auth-server, the cookie, session and
escrow audit keys and the ses-bridge ingest secret - along with the certificate authority for end-to-end encrypted mail.
The chart doesn't install OpenBao any more than it installs cert-manager: this script does, and it also initialises the
vault, writes each secret once (a re-run never re-keys anything), creates the PKI mount and issuing role, and hands the
chart the two tokens it reads them with. [External Secrets](https://external-secrets.io) then copies the values into the
Kubernetes Secrets the pods load.

The vault's unseal key and root token are kept in the `openbao-keys` Secret in the `openbao` namespace, and an
`openbao-unsealer` Deployment uses the key to unseal the vault after a pod restart, an upgrade or an instance reboot -
which is what makes an unattended instance come back on its own. **Back that Secret up**: without it nothing in the vault
can be recovered, and anyone who can read Secrets in that namespace can unseal it.

`RAPIDMX_OPENBAO_ADDRESS` points the chart at an OpenBao you already run, in which case this script installs and prepares
nothing - the kv path, the PKI mount and the token Secrets are yours to create (the server's README lists the exact paths
and fields). `EnableOpenBao=false` keeps every secret in Kubernetes Secrets instead, with the values printed in the
install summary.

For a bare-metal or on-premises host, use `single_node_install.sh` in the repository root instead, which fronts the
Gateway with nginx on the host and runs Postfix for mail.
