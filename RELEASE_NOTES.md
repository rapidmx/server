# Release Notes

## Unreleased

### Breaking changes

- **`global.mailIngestSecret` replaces `mail.ingestSecret` as the required secret.** It's shared by the server and the
  bundled postfix-bridge; `mail.ingestSecret` now defaults to it. An install that only sets `mail.ingestSecret` fails to
  render until `global.mailIngestSecret` is set to the same value.
- **Postfix and postfix-bridge are installed with the chart** (the `postfixBridge` dependency, postfix-bridge 1.1.0). A
  release that installed the postfix-bridge chart separately gets a second Postfix: uninstall that release, or set
  `postfixBridge.create=false`.

### Features

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
