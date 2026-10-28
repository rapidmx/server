#!/usr/bin/env bash
# set -e
IS_WSL=false
# The mail domain, e.g. example.com: mail is addressed @<domain>, the server is served at mail.<domain> and the
# auth-server at auth.<domain>. MAIL_HOST/AUTH_HOST (--mail-host/--auth-host) change those two names, as a bare label
# ("rapidmx" -> rapidmx.<domain>) or a whole host name.
DOMAIN="cluster.local"
MAIL_HOST=${MAIL_HOST:-mail}
AUTH_HOST=${AUTH_HOST:-auth}
# Whether the release also certifies and routes openpgpkey.<domain> (--openpgpkey-host true|false|auto), the OpenPGP Web Key
# Directory host Proton Mail, GnuPG and Thunderbird look keys up on first (the chart's mail.wkd.openpgpkeyHost.enabled). The name
# needs a DNS record before Let's Encrypt can issue for it, and without one $SERVER_HOST's certificate (which covers it) is never
# issued. auto (the default) serves it when the record already resolves to this server; with --dns-provider the provider publishes
# the record, so the release is installed without the host first and upgraded with it once the record resolves (decideOpenpgpkeyHost).
# true serves it whatever the record says. The server answers the Web Key Directory on $SERVER_HOST either way.
OPENPGPKEY_HOST=${OPENPGPKEY_HOST:-auto}
# What the release is installed with at this point (the chart's value), and whether the host waits for its record to be published.
OPENPGPKEY_ON=false
OPENPGPKEY_PENDING=false
TLS=true
VERSION="1.0.0-beta.46"
NAMESPACE="rapidmx"
# How the release is exposed through Envoy Gateway. "shared": this script creates one Gateway ($GATEWAY_NAME in
# $GATEWAY_NAMESPACE) with a listener per host and the chart's routes attach to it. "chart": the chart creates its own
# Gateways (one per host) in $NAMESPACE.
GATEWAY_MODE=${GATEWAY_MODE:-shared}
# Where Envoy Gateway runs, and so where the Envoy pods and Services it provisions are.
ENVOY_NAMESPACE=${ENVOY_NAMESPACE:-envoy-gateway-system}
GATEWAY_NAME=shared-gateway
GATEWAY_NAMESPACE=$ENVOY_NAMESPACE
# The published chart: the CI pushes ./helm (chart name "server") to oci://ghcr.io/<owner>/charts. Set CHART to a local
# chart directory (e.g. CHART=./helm) to install from a checkout instead; --version is then ignored.
CHART=${CHART:-oci://ghcr.io/rapidmx/charts/server}
# Helm release (https://github.com/helm/helm/releases) whose get-helm-3 installer script is run when helm is missing and snap
# is unavailable. Pinned to a tag so the script that runs as root can't change underneath us; it still installs helm itself.
HELM_SCRIPT_VERSION=${HELM_SCRIPT_VERSION:-v3.19.0}
# k3s release (the stable channel's at the time of writing) and cert-manager chart, pinned like everything else this installs, so
# a run later on can't pull in a release that was never tested with the chart. Only used when this script installs them.
K3S_VERSION=${K3S_VERSION:-v1.36.5+k3s1}
CERT_MANAGER_VERSION=${CERT_MANAGER_VERSION:-v1.21.2}
# Envoy Gateway release (https://github.com/envoyproxy/gateway/releases). Pinned: v0.0.0-latest tracks main.
ENVOY_GATEWAY_VERSION=${ENVOY_GATEWAY_VERSION:-v1.9.1}
# External Secrets release (https://github.com/external-secrets/external-secrets), which the charts' OpenBao support
# needs: it copies the vault's values into the Kubernetes Secrets the pods read.
EXTERNAL_SECRETS_VERSION=${EXTERNAL_SECRETS_VERSION:-2.10.0}
# OpenBao (https://openbao.org) is where the release keeps its secrets - the JWT secret it shares with the auth-server,
# the cookie, session and escrow audit keys and the postfix-bridge ingest secret - and the CA that issues certificates
# for end-to-end encrypted mail. Like cert-manager it's installed here rather than by the chart, because it's a cluster
# service several releases can share. --openbao false keeps every secret in Kubernetes Secrets instead.
OPENBAO=true
OPENBAO_VERSION=${OPENBAO_VERSION:-0.29.4}
OPENBAO_NAMESPACE=${OPENBAO_NAMESPACE:-openbao}
# The image the unsealer runs; only needs the `bao` CLI, so it's the same one the vault uses.
OPENBAO_IMAGE=${OPENBAO_IMAGE:-openbao/openbao:2.6.2}
OPENBAO_STORAGE_SIZE=${OPENBAO_STORAGE_SIZE:-1Gi}
# An OpenBao this cluster already runs, e.g. https://vault.example.com:8200 (https, unless it is this host). Set it and this
# script installs none, leaving the kv path, the PKI mount and the External Secrets token Secret for you to create - see
# "Secrets and OpenBao" in README.md for what the chart expects to find. OPENBAO_CA_FILE names a PEM file with the CA its
# listener's certificate comes from, when the system doesn't trust it.
OPENBAO_ADDRESS=${OPENBAO_ADDRESS:-}
OPENBAO_CA_FILE=${OPENBAO_CA_FILE:-}
OPENBAO_POD=openbao-0
# The vault this script installs listens with TLS only, so the `bao` CLI in its pod is pointed at https too (the certificate
# names 127.0.0.1, and the pod's BAO_CACERT trusts its CA).
OPENBAO_LOCAL_ADDRESS=https://127.0.0.1:8200
# The listener's certificate and the CA it is issued from, both made by cert-manager in OpenBao's namespace. The certificate
# lasts a year and is renewed 30 days ahead; a sidecar in the vault's pod sends OpenBao SIGHUP when it is, which reloads it
# without sealing anything.
OPENBAO_TLS_SECRET=openbao-tls
OPENBAO_CA_SECRET=openbao-ca
OPENBAO_TLS_DIR=/openbao/userconfig/openbao-tls
# The audience of the ServiceAccount tokens the release's clients log in to OpenBao with, which every role checks: a token
# the kubelet gives a pod for the Kubernetes API can't log in, and these are no use against the API.
OPENBAO_AUDIENCE=openbao
# Holds the unseal key and the root token: this is what makes the vault unseal itself after a restart, and what an
# attacker who can read Secrets in that namespace would get.
OPENBAO_KEYS_SECRET=openbao-keys
# The kv v2 mount, the PKI mount and the issuing role, which must match the chart's global.openbao.kvMount and
# openbao.pki.mount/role.
OPENBAO_KV_MOUNT=${OPENBAO_KV_MOUNT:-secret}
OPENBAO_PKI_MOUNT=${OPENBAO_PKI_MOUNT:-pki}
OPENBAO_PKI_ROLE=${OPENBAO_PKI_ROLE:-rapidmx-encryption}
# Comma-separated domains Postfix knows when it starts (postfixBridge.domains). Defaults to --domain. Every other domain added in the
# admin console works without a restart or a re-run.
MAIL_DOMAINS=""
# DNS publishing (restapi's specs/dns_publishing_and_integrations.md, 12): --dns-provider turns it on, creates the first provider config
# (the zone of --domain, or --dns-zone) from credentials in the environment or in --dns-credentials-file, installs the DNSEndpoint CRD and
# detects the public addresses of the mail host (--public-address overrides them). --dns-takeover lets the provider replace records that
# are already there. --keep-dns (with --uninstall) leaves every published record in DNS.
DNS_PROVIDER=${DNS_PROVIDER:-}
DNS_ZONE=""
DNS_CREDENTIALS_FILE=""
DNS_TAKEOVER=false
KEEP_DNS=false
PUBLIC_ADDRESSES=()
# Global IPv6 addresses the node has that detectPublicAddresses found and did not publish (the mail ports reach Postfix over IPv4 only).
UNPUBLISHED_IPV6=()
# Whether the domains this run seeds are on the installer's DNS provider, which is what makes their records published (checkDnsDomainsAssigned), and
# whether the provider config existed before this run (finishDnsBootstrap), which is when --dns-takeover isn't applied.
DNS_DOMAINS_ASSIGNED=true
DNS_CONFIG_EXISTED=false
# When the credentials Secret was made, so finishDnsBootstrap reads only what the server said after that.
DNS_SECRET_APPLIED_AT=""
# How many times a lookup that decides whether openpgpkey.<domain> is served is tried before it is taken to say no.
OPENPGPKEY_LOOKUP_TRIES=${OPENPGPKEY_LOOKUP_TRIES:-3}
# The dns-controller release the chart pins (dns.controller.image). Empty keeps the chart's own pin, which is empty until the controller's
# first release is published: the chart then refuses to render with publishing on. DNS_CONTROLLER_DIGEST (sha256:...) is used instead of the tag.
DNS_CONTROLLER_TAG=${DNS_CONTROLLER_TAG:-}
DNS_CONTROLLER_DIGEST=${DNS_CONTROLLER_DIGEST:-}
# The services that tell an address from outside, for a node that has only private ones (NAT, cloud).
PUBLIC_IPV4_URL=${PUBLIC_IPV4_URL:-https://api.ipify.org}
# How long to wait (seconds) for the server's rollout, for openpgpkey.<domain> to resolve once the provider has published it, and for
# the records to leave DNS after an uninstall removed them.
DNS_ROLLOUT_TIMEOUT=${DNS_ROLLOUT_TIMEOUT:-15m}
OPENPGPKEY_WAIT_SECONDS=${OPENPGPKEY_WAIT_SECONDS:-600}
DNS_CLEANUP_WAIT_SECONDS=${DNS_CLEANUP_WAIT_SECONDS:-600}
# The CRD external-dns reads (cluster-scoped, so the installer applies it like cert-manager's, and the chart does not).
DNS_CRD_NAME=dnsendpoints.externaldns.k8s.io
UNINSTALL=false
# --yes: confirms --uninstall, which deletes the cluster (or the release) with its mail, DKIM keys and encryption CA.
CONFIRM_UNINSTALL=false
SKIP_K3S=false
# The user the kubeconfig is installed for: the one who ran `sudo ./single_node_install.sh`, or the current user.
INSTALL_USER=${SUDO_USER:-`id -un`}
INSTALL_HOME=`getent passwd "$INSTALL_USER" | cut -d: -f6`
INSTALL_HOME=${INSTALL_HOME:-$HOME}
USER_KUBECONFIG="$INSTALL_HOME/.kube/config"
K3S_KUBECONFIG=/etc/rancher/k3s/k3s.yaml
K3S_OPTIONS="--disable=traefik"
# Markers around the block this script appends to nginx.conf, so a re-run replaces it instead of adding another.
NGINX_CONF=/etc/nginx/nginx.conf
NGINX_BEGIN="# BEGIN rapidmx"
NGINX_END="# END rapidmx"
# Prefix of the nginx.conf lines this script commented out (http server blocks listening on port 80); --uninstall
# restores them.
NGINX_DISABLED_PREFIX="#rapidmx# "
# What this script installed itself (as opposed to found already there), one key=value per line, so --uninstall only
# removes that.
STATE_DIR=/var/lib/rapidmx-installer
STATE_FILE="$STATE_DIR/state"
# The host firewall rules this script added, one per line: "firewalld <zone> <kind> <value>" (e.g.
# "firewalld public port 80/tcp") or "ufw <rule>" (e.g. "ufw allow 80/tcp").
FIREWALL_RULES="$STATE_DIR/firewall"
# Internal vars
LINES=$(tput lines 2>/dev/null || echo 24)
COLS=$(tput cols 2>/dev/null || echo 80)
total_steps=8
current=0
current_step="Initializing..."
previous_step=""
progress_pid=""
running=true
VALUES_FILE=""

# Shared functions
function addHelmRepo() {
  REPO_NAME=$1
  REPO_URL=$2
  if [[ `helm repo list 2>/dev/null | awk '{print $1}' | grep -Fx "$REPO_NAME" | wc -l` -eq 0 ]]; then
    echo "Adding helm repo $REPO_NAME - $REPO_URL"
    helm repo add "$REPO_NAME" "$REPO_URL"
  fi
}

function draw_progress() {
  local cur="$current"
  local step="$current_step"
  local current_step_length=${#step}
  local template="%s... [%d/%d]%s %d%% "
  local template_length=${#template}
  template_length=$(( template_length + current_step_length ))
  local bar_char='|'
  local percent_done=$(( cur * 100 / total_steps ))
  local length=$(( COLS - template_length ))
  local num_bars=$(( percent_done * length / 100 ))

  local i
  local s='['
  for ((i = 0; i < num_bars; i++)); do
    s+=$bar_char
  done
  for ((i = num_bars; i < length; i++)); do
    s+=' '
  done
  s+=']'

  printf '\e7' # save the cursor location
  printf '\e[%d;%dH' "$LINES" 0 # move cursor to the bottom line
  printf '\e[0K' # clear the line
  if [[ $cur -gt 0 ]]; then
    printf "$template" "$step" "$cur" "$total_steps" "$s" "$percent_done" # print the progress bar
  else
    printf ""
  fi
  printf '\e8' # restore the cursor location
}

# Background refresher
function progress_loop() {
  if [[ "$1" != "--bg" ]]; then
      echo "ERROR: progress_loop must be run in background" >&2
      exit 1
  fi

  echo
  while $running; do
      draw_progress
      sleep 0.2
  done
}

function run_step() {
  previous_step="$current_step"
  current_step="$1"
  if [[ "$previous_step" != "" ]]; then
    local step_length=${#previous_step}
    local length=$(( COLS - step_length - 15 ))
    local s=''
    local i
    for ((i = 0; i < length; i++)); do
      s+=' '
    done
    printf "[%d/%d] %s...%s[\e[32mDone\e[0m]\n" "$current" "$total_steps" "$previous_step" "$s"
  fi
  current=$(( current + 1 ))
  draw_progress
}

function cleanup() {
  running=false
  if [[ -n "$progress_pid" ]] && kill -0 "$progress_pid" 2>/dev/null; then
      kill "$progress_pid" 2>/dev/null
      wait "$progress_pid" 2>/dev/null
  fi
  # The helm values file holding the secrets.
  if [[ -n "$VALUES_FILE" ]]; then
    rm -f "$VALUES_FILE"
  fi
}

# Waits (up to 30 minutes) until namespace $1 has Deployments and all of them are Available. Used instead of counting
# pods that aren't "Running", which never settles when a namespace has a completed Job pod (cert-manager's
# startupapicheck).
function waitForDeployments() {
  local ns=$1
  local name=$2
  echo "Checking $name has started..."
  local startTime
  startTime=`date +%s`
  until [[ `kubectl -n "$ns" get deployments --no-headers 2>/dev/null | wc -l` -gt 0 ]]; do
    if [[ $(( `date +%s` - startTime )) -ge 1800 ]]; then
      echo "There was a problem installing $name..."
      exit 1
    fi
    echo "Waiting for $name to start..."
    sleep 5
  done
  if ! kubectl -n "$ns" wait --for=condition=Available deployment --all --timeout=30m; then
    echo "There was a problem installing $name..."
    exit 1
  fi
  echo "$name is running!"
}

# Copies k3s' cluster-admin kubeconfig to the installing user's ~/.kube/config, readable only by that user.
function installKubeconfig() {
  local group
  group=`id -gn "$INSTALL_USER"`
  sudo install -d -m 0700 -o "$INSTALL_USER" -g "$group" "$INSTALL_HOME/.kube"
  if sudo test -f "$USER_KUBECONFIG" && ! sudo cmp -s "$K3S_KUBECONFIG" "$USER_KUBECONFIG"; then
    local backup
    backup="$USER_KUBECONFIG.bak.`date +%s`"
    echo "Backing up the existing $USER_KUBECONFIG to $backup"
    sudo cp -p "$USER_KUBECONFIG" "$backup"
  fi
  sudo install -m 0600 -o "$INSTALL_USER" -g "$group" "$K3S_KUBECONFIG" "$USER_KUBECONFIG"
  # Earlier versions of this script exported KUBECONFIG=/etc/rancher/k3s/k3s.yaml from ~/.bashrc, which is no longer
  # readable by the user.
  if [[ -f "$INSTALL_HOME/.bashrc" ]]; then
    sudo sed -i "\#^export KUBECONFIG=$K3S_KUBECONFIG\$#d" "$INSTALL_HOME/.bashrc"
  fi
}

# The host name for label $2 in domain $1: a bare label ("mail") becomes mail.<domain>, anything containing a dot is
# taken as the whole host name.
function hostFor() {
  case "$2" in
    *.*) echo "$2";;
    *) echo "$2.$1";;
  esac
}

# A field (a jsonpath such as .spec.clusterIP) of the Envoy Service envoy-gateway provisioned for the Gateway(s) that
# $ENVOY_SELECTOR selects.
function gatewayService() {
  kubectl -n "$ENVOY_NAMESPACE" get svc -l "$ENVOY_SELECTOR" -o jsonpath="{.items[0]$1}" 2>/dev/null
}

# Waits (up to 5 minutes) for that Service to be a ClusterIP Service with port 80, and sets GATEWAY_IP and GATEWAY_ADDRESS
# (the address bracketed when it's IPv6). It doesn't wait for port 443: whether that appears before the HTTPS listeners
# have their certificates is up to envoy-gateway, and the certificates are issued through this Service.
function waitForGatewayService() {
  local startTime type
  echo "Waiting for the Gateway's Envoy Service..."
  GATEWAY_IP=""
  startTime=`date +%s`
  while [[ $(( `date +%s` - startTime )) -lt 300 ]]; do
    GATEWAY_IP=`gatewayService .spec.clusterIP`
    type=`gatewayService .spec.type`
    if [[ -n "$GATEWAY_IP" && "$type" = "ClusterIP" && -n "`gatewayService '.spec.ports[?(@.port==80)].port'`" ]]; then
      break
    fi
    GATEWAY_IP=""
    sleep 2
  done
  if [[ -z "$GATEWAY_IP" ]]; then
    echo "There was a problem setting up the Gateway: its Envoy Service isn't a ClusterIP Service with port 80."
    if [[ "$type" = "NodePort" ]]; then
      echo "An earlier version of this script made it a NodePort Service. Delete it (envoy-gateway recreates it) and re-run:"
      echo "  kubectl -n $ENVOY_NAMESPACE delete svc -l $ENVOY_SELECTOR"
    fi
    exit 1
  fi
  GATEWAY_ADDRESS=$GATEWAY_IP
  if [[ "$GATEWAY_IP" = *:* ]]; then
    GATEWAY_ADDRESS="[$GATEWAY_IP]"
  fi
}

# Single-quotes a value for YAML.
function yamlQuote() {
  local value=${1//\'/\'\'}
  printf "'%s'" "$value"
}

# Single-quotes a value for sh, for a command that runs inside the OpenBao pod.
function shQuote() {
  local value=${1//\'/\'\\\'\'}
  printf "'%s'" "$value"
}

# Records that this script installed $1 (the value, e.g. how, is $2). The first record wins: a re-run that finds the
# item already there doesn't forget that this script installed it.
function recordInstalled() {
  sudo install -d -m 0755 "$STATE_DIR"
  if ! sudo grep -q "^$1=" "$STATE_FILE" 2>/dev/null; then
    echo "$1=${2:-true}" | sudo tee -a "$STATE_FILE" > /dev/null
  fi
}

# The value recordInstalled stored for $1, or nothing when this script didn't install it.
function installedBy() {
  sudo sed -n "s/^$1=//p" "$STATE_FILE" 2>/dev/null | head -n 1
}

# Comments out (with $NGINX_DISABLED_PREFIX) each server {} block directly inside http {} of nginx.conf that listens on
# port 80, such as the default server of the stock RHEL/Fedora nginx.conf: the stream {} proxy below needs port 80, and
# nginx fails to start while an http server binds it too. Already commented lines are ignored, so it's idempotent.
function disablePort80HttpServers() {
  local tmp
  tmp=`mktemp`
  # Reads nginx.conf as root; the output goes to this user's own temporary file.
  # shellcheck disable=SC2024
  sudo awk -v prefix="$NGINX_DISABLED_PREFIX" '
    function flush(disable,   i) {
      for (i = 1; i <= n; i++) print (disable ? prefix : "") buf[i]
      n = 0
    }
    {
      code = $0
      sub(/#.*/, "", code)
      if (depth == 0 && code ~ /^[[:space:]]*http[[:space:]]*\{/) inHttp = 1
      if (inHttp && depth == 1 && !inServer && code ~ /^[[:space:]]*server[[:space:]]*\{/) { inServer = 1; listens80 = 0 }
      if (inServer && code ~ /(^|[[:space:]])listen[[:space:]]+([^[:space:];]*:)?80([[:space:];]|$)/) listens80 = 1
      depth += gsub(/\{/, "{", code) - gsub(/\}/, "}", code)
      if (inServer) {
        buf[++n] = $0
        if (depth <= 1) { flush(listens80); inServer = 0; if (listens80) disabled = 1 }
      } else {
        print
      }
      if (depth <= 0) inHttp = 0
    }
    END { flush(0); exit disabled ? 0 : 3 }
  ' "$NGINX_CONF" > "$tmp"
  local rc=$?
  if [[ $rc -eq 0 ]]; then
    echo "Commenting out the http server block(s) in $NGINX_CONF that listen on port 80 (restored by --uninstall)."
    sudo cp "$tmp" "$NGINX_CONF"
    recordInstalled nginx_port80_servers disabled
  fi
  rm -f "$tmp"
}

# The active host firewall: "firewalld" (RHEL/Fedora's default, also installable on Debian), "ufw" (Ubuntu's, also
# installable on Debian), or nothing (e.g. Debian's default, or a firewall this script doesn't manage). Both commands live
# in /usr/sbin, which is only on sudo's PATH on Debian.
function activeFirewall() {
  if systemctl is-active --quiet firewalld 2>/dev/null; then
    echo firewalld
  elif sudo ufw status 2>/dev/null | grep -q '^Status: active'; then
    echo ufw
  fi
}

# Runs `ufw allow $@`; succeeds only when that added the rule. ufw answers "Skipping adding existing rule" for one that
# was already there (the user's own, which --uninstall must leave alone) and "Rules updated" when it added it.
function ufwAllow() {
  sudo ufw allow "$@" 2>&1 | grep -q '^Rules updated'
}

function recordFirewallRule() {
  sudo install -d -m 0755 "$STATE_DIR"
  echo "$*" | sudo tee -a "$FIREWALL_RULES" > /dev/null
}

# Lets traffic from CIDR $1 reach this host (k3s' pod and service networks) in the active firewall, unless already
# allowed, recording the rule for --uninstall.
function firewallTrustSource() {
  case "`activeFirewall`" in
    firewalld)
      if ! sudo firewall-cmd --permanent --zone=trusted "--query-source=$1" >/dev/null 2>&1 \
          && sudo firewall-cmd --permanent --zone=trusted "--add-source=$1" >/dev/null; then
        recordFirewallRule firewalld trusted source "$1"
        sudo firewall-cmd --reload >/dev/null
      fi
      ;;
    ufw)
      if ufwAllow from "$1" to any; then
        recordFirewallRule ufw allow from "$1" to any
      fi
      ;;
  esac
}

# Opens port $1 (e.g. 80/tcp, or a range such as 49152-49252/udp) in the active firewall, unless already open, recording the
# rule for --uninstall. firewalld writes a range with a hyphen and ufw with a colon.
function firewallOpenPort() {
  case "`activeFirewall`" in
    firewalld)
      local zone
      zone=`sudo firewall-cmd --get-default-zone`
      if ! sudo firewall-cmd --permanent --zone="$zone" "--query-port=$1" >/dev/null 2>&1 \
          && sudo firewall-cmd --permanent --zone="$zone" "--add-port=$1" >/dev/null; then
        recordFirewallRule firewalld "$zone" port "$1"
        sudo firewall-cmd --reload >/dev/null
      fi
      ;;
    ufw)
      if ufwAllow "${1/-/:}"; then
        recordFirewallRule ufw allow "${1/-/:}"
      fi
      ;;
  esac
}

# The secrets the chart needs, reused from an existing install so a re-run never rotates them: re-keying would sign every
# user out, break the escrow audit log's hash chain and stop postfix-bridge authenticating. An install that kept them in
# Kubernetes Secrets carries them into the vault this way too.
function existingSecret() {
  for name in "$NAMESPACE-$1" "$NAMESPACE-server-$1"; do
    value=`kubectl -n "$NAMESPACE" get secret "$name" -o jsonpath="{.data.$2}" 2>/dev/null | base64 -d 2>/dev/null`
    if [[ -n "$value" ]]; then
      echo "$value"
      return
    fi
  done
}

# Succeeds when $1 may be the address of a vault this script doesn't install: https, or plain http to this host only.
function openbaoAddressAllowed() {
  case "$1" in
    https://*) return 0;;
    http://127.0.0.1|http://127.0.0.1:*|http://127.0.0.1/*) return 0;;
    http://localhost|http://localhost:*|http://localhost/*) return 0;;
    "http://[::1]"|"http://[::1]:"*|"http://[::1]/"*) return 0;;
  esac
  return 1
}

# The cert-manager objects for OpenBao's listener, all in its namespace: a self-signed CA of its own (ten years, its key kept
# when cert-manager renews it, so the copy in the release's namespace stays valid) and the listener's certificate from it, for
# every name the vault is reached at - its Services, its pod, and 127.0.0.1 for the `bao` CLI in the pod.
function openbaoTlsManifest() {
  local ns=$OPENBAO_NAMESPACE
  cat << EOF
apiVersion: cert-manager.io/v1
kind: Issuer
metadata:
  name: openbao-selfsigned
  namespace: $ns
spec:
  selfSigned: {}
---
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: $OPENBAO_CA_SECRET
  namespace: $ns
spec:
  isCA: true
  commonName: OpenBao CA ($ns)
  secretName: $OPENBAO_CA_SECRET
  duration: 87600h
  privateKey:
    algorithm: ECDSA
    size: 256
    rotationPolicy: Never
  issuerRef:
    name: openbao-selfsigned
    kind: Issuer
---
apiVersion: cert-manager.io/v1
kind: Issuer
metadata:
  name: openbao-ca
  namespace: $ns
spec:
  ca:
    secretName: $OPENBAO_CA_SECRET
---
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: $OPENBAO_TLS_SECRET
  namespace: $ns
spec:
  secretName: $OPENBAO_TLS_SECRET
  duration: 8760h
  renewBefore: 720h
  privateKey:
    algorithm: ECDSA
    size: 256
    rotationPolicy: Always
  dnsNames:
    - openbao
    - openbao.$ns
    - openbao.$ns.svc
    - openbao.$ns.svc.cluster.local
    - openbao-0.openbao-internal
    - openbao-0.openbao-internal.$ns
    - openbao-0.openbao-internal.$ns.svc
    - openbao-0.openbao-internal.$ns.svc.cluster.local
    - localhost
  ipAddresses:
    - 127.0.0.1
    - "::1"
  issuerRef:
    name: openbao-ca
    kind: Issuer
EOF
}

# Has cert-manager issue OpenBao's listener certificate, and waits (up to 5 minutes) until it is there: the vault's pod mounts it.
function issueOpenbaoCertificate() {
  kubectl create namespace "$OPENBAO_NAMESPACE" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
  # cert-manager's webhook may not take requests for a moment after it starts.
  local startTime
  startTime=`date +%s`
  until openbaoTlsManifest | kubectl apply -f - >/dev/null; do
    if [[ $(( `date +%s` - startTime )) -ge 300 ]]; then
      echo "There was a problem issuing OpenBao's listener certificate: cert-manager doesn't accept the request."
      exit 1
    fi
    sleep 5
  done
  if ! kubectl -n "$OPENBAO_NAMESPACE" wait --for=condition=Ready "certificate/$OPENBAO_TLS_SECRET" --timeout=5m >/dev/null; then
    echo "There was a problem issuing OpenBao's listener certificate: see kubectl -n $OPENBAO_NAMESPACE describe certificate $OPENBAO_TLS_SECRET"
    exit 1
  fi
}

# The reload sidecar's script: every $INTERVAL seconds (30) it hashes the mounted certificate and key, and when cert-manager has
# renewed them (the kubelet swaps the Secret volume's files at once) sends SIGHUP to the `bao server` process, which re-reads its
# listener certificate without sealing. It sees that process because the pod shares one process namespace, and may signal it
# because it runs as the same user. A change that found no server to signal is tried again on the next round. The server is the
# process whose first two arguments are `bao` (or a path ending in /bao) and `server`, read as separate arguments: this sidecar's
# own shell holds the script, "bao server" included, in its command line. It also skips itself and ignores SIGHUP, to be sure.
function openbaoReloadScript() {
  cat << 'EOF'
trap '' HUP
digest() {
  [ -s "$TLS_DIR/tls.crt" ] && [ -s "$TLS_DIR/tls.key" ] && cat "$TLS_DIR/tls.crt" "$TLS_DIR/tls.key" | sha256sum
}
isBaoServer() {
  tr '\0' '\n' < "$1/cmdline" 2> /dev/null | {
    IFS= read -r program && IFS= read -r verb && [ "$verb" = server ] &&
      case "$program" in bao|*/bao) true;; *) false;; esac
  }
}
loaded=$(digest)
while sleep "${INTERVAL:-30}"; do
  current=$(digest) || continue
  [ "$current" = "$loaded" ] && continue
  for dir in "${PROC_DIR:-/proc}"/[0-9]*; do
    [ "${dir##*/}" != "$$" ] && isBaoServer "$dir" || continue
    if kill -HUP "${dir##*/}"; then
      echo "Sent OpenBao SIGHUP to reload its renewed listener certificate."
      loaded=$current
    fi
  done
done
EOF
}

# The openbao chart's values: standalone, file storage on a volume, the listener on TLS only with cert-manager's certificate,
# and the reload sidecar, which runs the vault's own image (nothing new to pull or trust) as the vault's user, read-only, with
# no capabilities. The sidecar injector is off - External Secrets delivers the values instead.
function openbaoHelmValues() {
  cat << EOF
global:
  tlsDisable: false
injector:
  enabled: false
server:
  standalone:
    enabled: true
    config: |
      ui = true
      listener "tcp" {
        address = "[::]:8200"
        cluster_address = "[::]:8201"
        tls_cert_file = "$OPENBAO_TLS_DIR/tls.crt"
        tls_key_file = "$OPENBAO_TLS_DIR/tls.key"
      }
      storage "file" {
        path = "/openbao/data"
      }
  dataStorage:
    enabled: true
    size: $OPENBAO_STORAGE_SIZE
  extraVolumes:
    - type: secret
      name: $OPENBAO_TLS_SECRET
  extraEnvironmentVars:
    BAO_CACERT: $OPENBAO_TLS_DIR/ca.crt
  shareProcessNamespace: true
  extraContainers:
    - name: tls-reload
      image: $OPENBAO_IMAGE
      command: ["/bin/sh", "-c"]
      args:
        - |
`openbaoReloadScript | sed 's/^/          /'`
      env:
        - name: TLS_DIR
          value: $OPENBAO_TLS_DIR
      securityContext:
        runAsNonRoot: true
        runAsUser: 100
        runAsGroup: 1000
        readOnlyRootFilesystem: true
        allowPrivilegeEscalation: false
        capabilities:
          drop: ["ALL"]
      resources:
        requests:
          cpu: 5m
          memory: 16Mi
        limits:
          memory: 32Mi
      volumeMounts:
        - name: userconfig-$OPENBAO_TLS_SECRET
          mountPath: $OPENBAO_TLS_DIR
          readOnly: true
EOF
}

# The vault's StatefulSet only replaces its pod when the pod is deleted (the chart's OnDelete strategy), so a pod older than the
# StatefulSet's current revision - after the listener moved to TLS, say - is deleted here and comes back sealed, to be unsealed below.
function restartOpenbaoIfChanged() {
  local startTime revision current
  startTime=`date +%s`
  until [[ "`kubectl -n "$OPENBAO_NAMESPACE" get statefulset openbao -o jsonpath='{.status.observedGeneration}' 2>/dev/null`" = \
      "`kubectl -n "$OPENBAO_NAMESPACE" get statefulset openbao -o jsonpath='{.metadata.generation}' 2>/dev/null`" ]]; do
    if [[ $(( `date +%s` - startTime )) -ge 120 ]]; then
      break
    fi
    sleep 2
  done
  revision=`kubectl -n "$OPENBAO_NAMESPACE" get statefulset openbao -o jsonpath='{.status.updateRevision}' 2>/dev/null`
  current=`kubectl -n "$OPENBAO_NAMESPACE" get pod "$OPENBAO_POD" -o jsonpath='{.metadata.labels.controller-revision-hash}' 2>/dev/null`
  if [[ -n "$revision" && -n "$current" && "$revision" != "$current" ]]; then
    echo "Restarting OpenBao with its new configuration..."
    kubectl -n "$OPENBAO_NAMESPACE" delete pod "$OPENBAO_POD" --wait=true >/dev/null
  fi
}

# The unsealer: it does nothing while the vault is unsealed, and unseals it within ten seconds of it coming back. It reaches the
# vault over TLS, trusting only the CA of its listener (the ca.crt of the listener's Secret, without the key beside it).
function openbaoUnsealerManifest() {
  cat << EOF
apiVersion: apps/v1
kind: Deployment
metadata:
  name: openbao-unsealer
  namespace: $OPENBAO_NAMESPACE
  labels:
    app.kubernetes.io/name: openbao-unsealer
spec:
  replicas: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: openbao-unsealer
  template:
    metadata:
      labels:
        app.kubernetes.io/name: openbao-unsealer
    spec:
      automountServiceAccountToken: false
      securityContext:
        runAsNonRoot: true
        runAsUser: 100
        runAsGroup: 1000
      containers:
        - name: unsealer
          image: $OPENBAO_IMAGE
          command: ["/bin/sh", "-c"]
          args:
            - |
              while true; do
                if bao status -format=json 2>/dev/null | tr -d ' ' | grep -q '"sealed":true'; then
                  if bao operator unseal "\$UNSEAL_KEY" >/dev/null 2>&1; then
                    echo "Unsealed OpenBao."
                  else
                    echo "Could not unseal OpenBao; retrying."
                  fi
                fi
                sleep 10
              done
          env:
            - name: BAO_ADDR
              value: $OPENBAO_ADDRESS
            - name: BAO_CACERT
              value: /etc/openbao-ca/ca.crt
            - name: UNSEAL_KEY
              valueFrom:
                secretKeyRef:
                  name: $OPENBAO_KEYS_SECRET
                  key: unseal_key
          volumeMounts:
            - name: openbao-ca
              mountPath: /etc/openbao-ca
              readOnly: true
          resources:
            requests:
              cpu: 10m
              memory: 32Mi
          securityContext:
            allowPrivilegeEscalation: false
            capabilities:
              drop: ["ALL"]
      volumes:
        - name: openbao-ca
          secret:
            secretName: $OPENBAO_TLS_SECRET
            items:
              - key: ca.crt
                path: ca.crt
EOF
}

# Installs OpenBao and leaves it initialised and unsealed, with the unseal key and root token in $OPENBAO_KEYS_SECRET and
# a small Deployment beside it that unseals the vault again whenever it comes back sealed - which a pod restart, an
# upgrade and a node reboot all do. Keeping that key in a Secret is the trade for a vault that heals itself unattended:
# anyone who can read Secrets in that namespace can unseal it, which is roughly what those Secrets gave away before.
# A cluster with a KMS to auto-unseal from should run its own vault and be named with OPENBAO_ADDRESS instead.
# The vault listens with TLS only (its certificate is issued first, since the pod mounts it); one installed by an earlier
# version of this script, on plain HTTP, is moved to TLS and restarted.
function installOpenbao() {
  addHelmRepo openbao https://openbao.github.io/openbao-helm
  helm repo update openbao >/dev/null
  issueOpenbaoCertificate
  local isNew=false
  if ! helm status openbao -n "$OPENBAO_NAMESPACE" >/dev/null 2>&1; then
    isNew=true
  fi
  local values
  values=`mktemp "${TMPDIR:-/tmp}/openbao-values.XXXXXX"`
  openbaoHelmValues > "$values"
  if ! helm upgrade --install openbao openbao/openbao --version "$OPENBAO_VERSION" \
      -n "$OPENBAO_NAMESPACE" --create-namespace -f "$values"; then
    rm -f "$values"
    echo "There was a problem installing OpenBao."
    exit 1
  fi
  rm -f "$values"
  if [[ "$isNew" = "true" ]]; then
    recordInstalled openbao "$OPENBAO_NAMESPACE"
  fi
  restartOpenbaoIfChanged

  # A sealed vault never reports Ready, and it is sealed until the next step, so this waits for the pod to answer rather
  # than for readiness. `bao status` exits non-zero while sealed but still prints the status, which is what's checked.
  echo "Waiting for OpenBao to start..."
  local startTime
  startTime=`date +%s`
  until kubectl -n "$OPENBAO_NAMESPACE" exec "$OPENBAO_POD" -- bao status -address="$OPENBAO_LOCAL_ADDRESS" -format=json 2>/dev/null | grep -q '"sealed"'; do
    if [[ $(( `date +%s` - startTime )) -ge 600 ]]; then
      echo "There was a problem starting OpenBao: $OPENBAO_POD in namespace $OPENBAO_NAMESPACE doesn't answer."
      exit 1
    fi
    sleep 5
  done

  if kubectl -n "$OPENBAO_NAMESPACE" get secret "$OPENBAO_KEYS_SECRET" >/dev/null 2>&1; then
    OPENBAO_UNSEAL_KEY=`kubectl -n "$OPENBAO_NAMESPACE" get secret "$OPENBAO_KEYS_SECRET" -o jsonpath='{.data.unseal_key}' | base64 -d`
    OPENBAO_ROOT_TOKEN=`kubectl -n "$OPENBAO_NAMESPACE" get secret "$OPENBAO_KEYS_SECRET" -o jsonpath='{.data.root_token}' | base64 -d`
    if [[ -z "$OPENBAO_UNSEAL_KEY" || -z "$OPENBAO_ROOT_TOKEN" ]]; then
      echo "The $OPENBAO_KEYS_SECRET Secret in namespace $OPENBAO_NAMESPACE has no unseal_key/root_token, so this vault"
      echo "can't be unsealed or configured from here. Delete the Secret only if the vault's data is gone too, or point"
      echo "this script at a prepared vault with OPENBAO_ADDRESS."
      exit 1
    fi
  else
    echo "Initialising OpenBao..."
    # One key share, because the thing that unseals this vault is a Deployment, not a group of people.
    local init
    if ! init=`kubectl -n "$OPENBAO_NAMESPACE" exec "$OPENBAO_POD" -- bao operator init -address="$OPENBAO_LOCAL_ADDRESS" -key-shares=1 -key-threshold=1 -format=json`; then
      echo "There was a problem initialising OpenBao."
      exit 1
    fi
    OPENBAO_UNSEAL_KEY=`printf '%s' "$init" | tr -d ' \n' | sed -n 's/.*"unseal_keys_b64":\["\([^"]*\)".*/\1/p'`
    OPENBAO_ROOT_TOKEN=`printf '%s' "$init" | tr -d ' \n' | sed -n 's/.*"root_token":"\([^"]*\)".*/\1/p'`
    if [[ -z "$OPENBAO_UNSEAL_KEY" || -z "$OPENBAO_ROOT_TOKEN" ]]; then
      echo "OpenBao was initialised but its unseal key and root token couldn't be read back, so nothing can unseal it."
      echo "The vault's storage has to be deleted and this script re-run:"
      echo "  helm uninstall openbao -n $OPENBAO_NAMESPACE && kubectl delete pvc -n $OPENBAO_NAMESPACE --all"
      exit 1
    fi
    # Written from files, so neither value passes through this host's process list.
    local dir
    dir=`mktemp -d`
    chmod 700 "$dir"
    printf '%s' "$OPENBAO_UNSEAL_KEY" > "$dir/unseal_key"
    printf '%s' "$OPENBAO_ROOT_TOKEN" > "$dir/root_token"
    if ! kubectl -n "$OPENBAO_NAMESPACE" create secret generic "$OPENBAO_KEYS_SECRET" \
        --from-file="$dir/unseal_key" --from-file="$dir/root_token"; then
      rm -rf "$dir"
      echo "There was a problem storing OpenBao's unseal key, which leaves a vault nothing can unseal. Remove it and"
      echo "re-run this script: helm uninstall openbao -n $OPENBAO_NAMESPACE && kubectl delete pvc -n $OPENBAO_NAMESPACE --all"
      exit 1
    fi
    rm -rf "$dir"
  fi

  if ! kubectl -n "$OPENBAO_NAMESPACE" exec "$OPENBAO_POD" -- bao status -address="$OPENBAO_LOCAL_ADDRESS" -format=json 2>/dev/null | tr -d ' ' | grep -q '"sealed":false'; then
    echo "Unsealing OpenBao..."
    # `bao operator unseal` takes the key only as an argument (it refuses stdin and, unlike Vault, "-"), so a shell in the
    # pod reads it from stdin and passes it on: it isn't in this host's process list.
    if ! printf '%s\n' "$OPENBAO_UNSEAL_KEY" | kubectl -n "$OPENBAO_NAMESPACE" exec -i "$OPENBAO_POD" -- \
        sh -c 'read -r key && exec bao operator unseal -address="$1" "$key"' sh "$OPENBAO_LOCAL_ADDRESS" >/dev/null; then
      echo "There was a problem unsealing OpenBao."
      exit 1
    fi
  fi

  if ! openbaoUnsealerManifest | kubectl apply -f - >/dev/null; then
    echo "There was a problem installing the OpenBao unsealer, so the vault would stay sealed after a restart."
    exit 1
  fi
  echo "OpenBao is running and unsealed."
}

# True when $1 reads like a configuration keyring, the document restapi's parseConfigKeyring() reads: a "keys" array of objects with a "kid" and a "key".
# The server is what validates it fully (an unreadable ring stops it starting); this is what keeps the installer from copying a Secret's wrong content
# into the vault, where the create-only write would never replace it.
function looksLikeConfigKeyring() {
  local shape='"keys"[[:space:]]*:[[:space:]]*\[[[:space:]]*\{'
  [[ "$1" =~ $shape && "$1" == *'"kid"'* && "$1" == *'"key"'* ]]
}

# A new configuration keyring: a single key of 32 random bytes with an 8-hex kid, from openssl or, where it isn't installed, the kernel. What was
# generated is checked before it is used, since a failed command would otherwise leave an empty kid or key in a document the vault keeps for good.
function newConfigKeyring() {
  local kid key
  if command -v openssl >/dev/null 2>&1; then
    kid=`openssl rand -hex 4 2>/dev/null`
    key=`openssl rand -base64 32 2>/dev/null`
  else
    kid=`od -An -tx1 -N4 /dev/urandom | tr -d ' \n'`
    key=`head -c 32 /dev/urandom | base64 | tr -d '\n'`
  fi
  if [[ ! "$kid" =~ ^[0-9a-f]{8}$ || "`printf '%s' "$key" | base64 -d 2>/dev/null | wc -c | tr -d ' '`" != "32" ]]; then
    echo "Couldn't generate a configuration keyring: a key of 32 random bytes and an 8-digit hex id are needed." >&2
    return 1
  fi
  printf '{"keys":[{"kid":"%s","key":"%s","createdAt":"%s"}]}' "$kid" "$key" "`date -u +%Y-%m-%dT%H:%M:%S.000Z`"
}

# The configuration keyring to put in the vault the first time: the one in the Secret $KEYRING_SECRET, which the chart rendered (and Helm kept) for an
# install without OpenBao, so nothing needs re-encrypting when the deployment moves to OpenBao, or else a new one. A Secret that holds no keyring is an
# error, not a reason to start over with a new key, which would leave every value already encrypted unreadable.
function initialConfigKeyring() {
  local kept
  if kubectl -n "$NAMESPACE" get secret "$KEYRING_SECRET" >/dev/null 2>&1; then
    kept=`kubectl -n "$NAMESPACE" get secret "$KEYRING_SECRET" -o jsonpath='{.data.keyring\.json}' 2>/dev/null | base64 -d 2>/dev/null`
    if ! looksLikeConfigKeyring "$kept"; then
      echo "The Secret $KEYRING_SECRET in namespace $NAMESPACE holds no configuration keyring (its keyring.json) to move into OpenBao." >&2
      echo "Values already encrypted with it would become unreadable under a new key, so nothing was changed." >&2
      return 1
    fi
    printf '%s' "$kept"
    return 0
  fi
  newConfigKeyring
}

# Prepares the vault for this release: the kv v2 mount and this release's secrets, the PKI mount, issuing role and root CA
# the server signs mail encryption certificates from, and OpenBao's kubernetes auth method with a role and a policy per
# client. Each client logs in with a short-lived token of its own ServiceAccount, for the audience $OPENBAO_AUDIENCE, which the
# Kubernetes API vouches for (OpenBao asks it with its own ServiceAccount, which the openbao chart lets review tokens); the
# OpenBao token it gets lasts an hour. No long-lived token is made. It all runs inside the vault's own pod, over stdin, so no
# token or secret reaches either host's process list; re-running it changes nothing that already exists.
#  - $OPENBAO_SERVER_ROLE (the server): the PKI role's sign and revoke, and read and update on the configuration keyring's path
#    (which its key rotation writes) and read on that path's metadata (for the version it writes at), nothing else.
#  - $OPENBAO_ESO_ROLE (External Secrets): reads the release's secrets and the configuration keyring.
# The keyring (restapi's specs/dns_publishing_and_integrations.md, 5.3) is created at $OPENBAO_KV_MOUNT/$OPENBAO_KEYRING_PATH when the vault has
# none, from the Secret $KEYRING_SECRET an install without OpenBao kept or else a new key, and never written by this script again.
# No other configuration secret is kept in the vault, and the DNS controller has no role: the role and policy an earlier version of
# this script made for it are deleted (OpenBao answers success for one that isn't there).
function prepareOpenbao() {
  local kv=$OPENBAO_KV_MOUNT keyring
  keyring=`initialConfigKeyring` || exit 1
  if ! kubectl -n "$OPENBAO_NAMESPACE" exec -i "$OPENBAO_POD" -- sh -s > /dev/null << EOF
set -e
export BAO_ADDR=$OPENBAO_LOCAL_ADDRESS
export BAO_TOKEN=`shQuote "$OPENBAO_ROOT_TOKEN"`

# The kv v2 engine the chart reads this release's secrets from (its global.openbao.kvMount).
bao secrets list -format=json | grep -q '"$kv/"' || bao secrets enable -path=$kv -version=2 kv > /dev/null

# A value already in the vault always wins, so an upgrade never re-keys anything.
seed() {
  if [ -n "\`bao kv get -mount=$kv -field="\$1" $OPENBAO_SECRETS_PATH 2> /dev/null\`" ]; then
    return 0
  fi
  bao kv patch -mount=$kv $OPENBAO_SECRETS_PATH "\$1=\$2" > /dev/null 2>&1 ||
    bao kv put -mount=$kv $OPENBAO_SECRETS_PATH "\$1=\$2" > /dev/null
}
seed auth_secret `shQuote "$AUTH_SECRET"`
seed cookie_secret `shQuote "$COOKIE_SECRET"`
seed session__secret `shQuote "$SESSION_SECRET"`
seed escrow_audit_hmac_key `shQuote "$ESCROW_HMAC_KEY"`
seed mail_ingest_secret `shQuote "$MAIL_INGEST_SECRET"`

# The configuration keyring, in a path of its own so the server's policy can be limited to it. Created once and never replaced: the server's
# key rotation owns it afterwards, and -cas=0 makes a keyring that appeared meanwhile win. It goes in over stdin, not as an argument.
if [ -z "\`bao kv get -mount=$kv -field=keyring $OPENBAO_KEYRING_PATH 2> /dev/null\`" ]; then
  printf '%s' `shQuote "$keyring"` | bao kv put -mount=$kv -cas=0 $OPENBAO_KEYRING_PATH keyring=- > /dev/null
fi

# The PKI backend the server's encryption CA uses: it signs the certificate signing requests browsers generate, so the
# private keys stay with the clients and the CA key never leaves the vault. The role has to accept an email address as
# the common name, which is why host name enforcement is off.
bao secrets list -format=json | grep -q '"$OPENBAO_PKI_MOUNT/"' || bao secrets enable -path=$OPENBAO_PKI_MOUNT -max-lease-ttl=87600h pki > /dev/null
if [ -z "\`bao read -field=certificate $OPENBAO_PKI_MOUNT/cert/ca 2> /dev/null\`" ]; then
  bao write -field=certificate $OPENBAO_PKI_MOUNT/root/generate/internal common_name=`shQuote "$DOMAIN Mail Encryption CA"` ttl=87600h > /dev/null
fi
bao write $OPENBAO_PKI_MOUNT/roles/$OPENBAO_PKI_ROLE \
  allow_any_name=true enforce_hostnames=false allow_ip_sans=false \
  use_csr_common_name=false use_csr_sans=true key_type=any \
  ext_key_usage=EmailProtection key_usage=KeyAgreement,KeyEncipherment \
  basic_constraints_valid_for_non_ca=true ttl=9528h max_ttl=9528h > /dev/null

# Kubernetes auth, checked against the API server this pod runs under.
bao auth list -format=json | grep -q '"kubernetes/"' || bao auth enable kubernetes > /dev/null
host=\$KUBERNETES_SERVICE_HOST
case "\$host" in *:*) host="[\$host]";; esac
bao write auth/kubernetes/config kubernetes_host="https://\$host:\$KUBERNETES_SERVICE_PORT" > /dev/null

bao policy write $OPENBAO_SERVER_ROLE - > /dev/null << 'POLICY'
path "$OPENBAO_PKI_MOUNT/sign/$OPENBAO_PKI_ROLE" {
  capabilities = ["update"]
}
path "$OPENBAO_PKI_MOUNT/revoke" {
  capabilities = ["update"]
}
path "$kv/data/$OPENBAO_KEYRING_PATH" {
  capabilities = ["read", "update"]
}
path "$kv/metadata/$OPENBAO_KEYRING_PATH" {
  capabilities = ["read"]
}
POLICY
bao policy write $OPENBAO_ESO_ROLE - > /dev/null << 'POLICY'
path "$kv/data/$OPENBAO_SECRETS_PATH" {
  capabilities = ["read"]
}
path "$kv/metadata/$OPENBAO_SECRETS_PATH" {
  capabilities = ["read"]
}
path "$kv/data/$OPENBAO_KEYRING_PATH" {
  capabilities = ["read"]
}
path "$kv/metadata/$OPENBAO_KEYRING_PATH" {
  capabilities = ["read"]
}
POLICY

role() {
  bao write "auth/kubernetes/role/\$1" bound_service_account_names="\$2" bound_service_account_namespaces=$NAMESPACE \
    audience=$OPENBAO_AUDIENCE token_policies="\$1" token_ttl=1h token_max_ttl=1h > /dev/null
}
role $OPENBAO_SERVER_ROLE $FULLNAME
role $OPENBAO_ESO_ROLE $OPENBAO_ESO_SERVICE_ACCOUNT

# The DNS controller's role and policy, made by an earlier version of this script.
bao delete auth/kubernetes/role/$FULLNAME-dns-controller > /dev/null
bao policy delete $FULLNAME-dns-controller > /dev/null
EOF
  then
    echo "There was a problem preparing OpenBao for this release."
    exit 1
  fi
  echo "OpenBao holds this release's secrets at $OPENBAO_KV_MOUNT/$OPENBAO_SECRETS_PATH."
}

# Copies the CA OpenBao's listener certificate comes from into the ConfigMap $OPENBAO_CA_CONFIGMAP in the release's namespace,
# where External Secrets and the server read it (the chart's global.openbao.caConfigMap): from the vault this script installed,
# or OPENBAO_CA_FILE for your own.
function copyOpenbaoCa() {
  local dir
  dir=`mktemp -d`
  if [[ -n "$OPENBAO_CA_FILE" ]]; then
    cp "$OPENBAO_CA_FILE" "$dir/ca.crt"
  else
    kubectl -n "$OPENBAO_NAMESPACE" get secret "$OPENBAO_TLS_SECRET" -o jsonpath='{.data.ca\.crt}' | base64 -d > "$dir/ca.crt"
  fi
  if [[ ! -s "$dir/ca.crt" ]]; then
    rm -rf "$dir"
    echo "There was a problem reading the CA of OpenBao's listener certificate."
    exit 1
  fi
  kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
  if ! kubectl -n "$NAMESPACE" create configmap "$OPENBAO_CA_CONFIGMAP" --from-file="$dir/ca.crt" --dry-run=client -o yaml \
      | kubectl apply -f - >/dev/null; then
    rm -rf "$dir"
    echo "There was a problem copying OpenBao's CA into namespace $NAMESPACE."
    exit 1
  fi
  rm -rf "$dir"
}

# After the keyring is in the vault: deletes the Secret $KEYRING_SECRET an install without OpenBao kept, so External Secrets can own it (the chart's
# ExternalSecret has creationPolicy Owner and can't take over a Secret it didn't create). Only once the vault holds exactly that Secret's keyring,
# compared inside the vault's pod (the keyring and the root token reach it over stdin), since what is already encrypted needs that ring and no other;
# a Secret External Secrets already owns is left alone. The pods keep the files they have mounted until the ExternalSecret has made the Secret again.
function releaseKeyringSecret() {
  if ! kubectl -n "$NAMESPACE" get secret "$KEYRING_SECRET" >/dev/null 2>&1; then
    return 0
  fi
  local owners kept version
  owners=`kubectl -n "$NAMESPACE" get secret "$KEYRING_SECRET" -o jsonpath='{.metadata.ownerReferences[*].kind}' 2>/dev/null`
  if [[ "$owners" == *ExternalSecret* ]]; then
    return 0
  fi
  # Read before the data, so a write in between shows as a changed version below.
  version=`kubectl -n "$NAMESPACE" get secret "$KEYRING_SECRET" -o jsonpath='{.metadata.resourceVersion}' 2>/dev/null`
  kept=`kubectl -n "$NAMESPACE" get secret "$KEYRING_SECRET" -o jsonpath='{.data.keyring\.json}' 2>/dev/null | base64 -d 2>/dev/null`
  if ! kubectl -n "$OPENBAO_NAMESPACE" exec -i "$OPENBAO_POD" -- sh -s > /dev/null << EOF
set -e
export BAO_ADDR=$OPENBAO_LOCAL_ADDRESS
export BAO_TOKEN=`shQuote "$OPENBAO_ROOT_TOKEN"`
# Fails, deleting nothing, unless the vault holds exactly the Secret's keyring.
[ "\`bao kv get -mount=$OPENBAO_KV_MOUNT -field=keyring $OPENBAO_KEYRING_PATH\`" = `shQuote "$kept"` ]
EOF
  then
    echo "The Secret $KEYRING_SECRET in namespace $NAMESPACE holds a configuration keyring that OpenBao's $OPENBAO_KV_MOUNT/$OPENBAO_KEYRING_PATH"
    echo "isn't, or can't be confirmed to be, the same one, so the Secret was kept. Values already encrypted need the keyring the Secret holds: put it"
    echo "in the vault, or delete the Secret if the vault's is the right one, then re-run this script."
    exit 1
  fi
  # The running pods still write this Secret until the chart switches them to the vault, and a key rotation they finish after the comparison above
  # would add a key to it that only the Secret holds. kubectl can't delete at a resourceVersion, so this leaves a window of the time between the two
  # calls, not of the comparison.
  if [[ -z "$version" || "`kubectl -n "$NAMESPACE" get secret "$KEYRING_SECRET" -o jsonpath='{.metadata.resourceVersion}' 2>/dev/null`" != "$version" ]]; then
    echo "The Secret $KEYRING_SECRET in namespace $NAMESPACE changed while it was compared with OpenBao's keyring (a key rotation, most likely), so it was kept."
    echo "Re-run this script once no rotation is in progress."
    exit 1
  fi
  kubectl -n "$NAMESPACE" delete secret "$KEYRING_SECRET" >/dev/null
  echo "The configuration keyring is in OpenBao now, and External Secrets takes over the Secret $KEYRING_SECRET."
}

# Moves an install from before Kubernetes auth off the two periodic tokens earlier versions of this script made: once every
# SecretStore in the release's namespace is Ready and a short-lived token of External Secrets' and of the server's
# ServiceAccount has logged in to its new role, each old token is revoked in the vault and its Secret deleted, with the two
# policies only they used. Until then nothing is revoked, so the release keeps working and a re-run finishes the move. Every
# token goes into the pod over stdin, never as an argument.
function migrateOpenbaoTokens() {
  local secrets=() tokens=() name token
  for name in "$OPENBAO_ESO_SECRET" "$OPENBAO_PKI_SECRET"; do
    if kubectl -n "$NAMESPACE" get secret "$name" >/dev/null 2>&1; then
      secrets+=("$name")
      token=`kubectl -n "$NAMESPACE" get secret "$name" -o jsonpath='{.data.*}' 2>/dev/null | base64 -d 2>/dev/null`
      # An OpenBao token is letters, digits, dots, dashes and underscores; anything else isn't put into a script.
      if [[ "$token" =~ ^[A-Za-z0-9._-]+$ ]]; then
        tokens+=("$token")
      fi
    fi
  done
  if [[ ${#secrets[@]} -eq 0 ]]; then
    return 0
  fi
  # External Secrets checks a SecretStore again when helm changes it; give it a moment, so an old Ready isn't taken for a new one.
  sleep 15
  if ! kubectl -n "$NAMESPACE" wait --for=condition=Ready secretstore --all --timeout=5m >/dev/null 2>&1; then
    echo "The old OpenBao tokens in ${secrets[*]} are kept for now: not every SecretStore in $NAMESPACE is Ready with"
    echo "Kubernetes auth yet (kubectl -n $NAMESPACE get secretstores). Re-run this script once they are to revoke them."
    return 0
  fi
  local esoJwt serverJwt
  esoJwt=`kubectl -n "$NAMESPACE" create token "$OPENBAO_ESO_SERVICE_ACCOUNT" --audience "$OPENBAO_AUDIENCE" --duration 10m 2>/dev/null`
  serverJwt=`kubectl -n "$NAMESPACE" create token "$FULLNAME" --audience "$OPENBAO_AUDIENCE" --duration 10m 2>/dev/null`
  if [[ ! "$esoJwt" =~ ^[A-Za-z0-9._-]+$ || ! "$serverJwt" =~ ^[A-Za-z0-9._-]+$ ]]; then
    echo "The old OpenBao tokens in ${secrets[*]} are kept for now: no token of $OPENBAO_ESO_SERVICE_ACCOUNT or $FULLNAME could be"
    echo "had to check their Kubernetes auth with. Re-run this script to revoke them."
    return 0
  fi
  local revoke=""
  for token in "${tokens[@]}"; do
    revoke+="revoke '$token'"$'\n'
  done
  if ! kubectl -n "$OPENBAO_NAMESPACE" exec -i "$OPENBAO_POD" -- sh -s > /dev/null << EOF
set -e
export BAO_ADDR=$OPENBAO_LOCAL_ADDRESS
export BAO_TOKEN=`shQuote "$OPENBAO_ROOT_TOKEN"`
# Fails, revoking nothing, while the vault is sealed or the root token doesn't work.
bao token lookup > /dev/null
# Fails, revoking nothing, unless the role logs in with the ServiceAccount token; the OpenBao token it gets is revoked at once.
login() {
  token=\`printf '{"role":"%s","jwt":"%s"}' "\$1" "\$2" | bao write -field=token auth/kubernetes/login -\`
  printf '{"token":"%s"}' "\$token" | bao write auth/token/revoke - > /dev/null
}
login $OPENBAO_ESO_ROLE '$esoJwt'
login $OPENBAO_SERVER_ROLE '$serverJwt'
revoke() {
  printf '{"token":"%s"}' "\$1" | bao write auth/token/revoke - > /dev/null || echo "A token was already gone."
}
$revoke
bao policy delete $FULLNAME-secrets-read > /dev/null
bao policy delete $FULLNAME-pki > /dev/null
EOF
  then
    echo "There was a problem revoking the old OpenBao tokens in ${secrets[*]}; they are kept, and a re-run tries again."
    return 0
  fi
  kubectl -n "$NAMESPACE" delete secret "${secrets[@]}" --ignore-not-found >/dev/null
  echo "Revoked the old OpenBao tokens and deleted ${secrets[*]}: the release logs in with Kubernetes auth now."
}

# After an upgrade: the certificate OpenBao serves must be the one in $OPENBAO_TLS_SECRET, which the reload sidecar makes it
# load when cert-manager renews it. A difference is reported, not fatal - OpenBao keeps serving the older one until it restarts.
function checkOpenbaoCertificate() {
  if ! command -v openssl >/dev/null 2>&1; then
    return 0
  fi
  local stored served pf i port=18200
  stored=`kubectl -n "$OPENBAO_NAMESPACE" get secret "$OPENBAO_TLS_SECRET" -o jsonpath='{.data.tls\.crt}' 2>/dev/null | base64 -d 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null`
  kubectl -n "$OPENBAO_NAMESPACE" port-forward "pod/$OPENBAO_POD" "$port:8200" >/dev/null 2>&1 &
  pf=$!
  for i in 1 2 3 4 5 6 7 8 9 10; do
    served=`openssl s_client -connect "127.0.0.1:$port" -servername "openbao.$OPENBAO_NAMESPACE.svc" < /dev/null 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null`
    if [[ -n "$served" ]]; then
      break
    fi
    sleep 1
  done
  kill "$pf" 2>/dev/null
  wait "$pf" 2>/dev/null
  if [[ -z "$stored" || -z "$served" ]]; then
    echo "Couldn't compare the certificate OpenBao serves with the one in its $OPENBAO_TLS_SECRET Secret."
  elif [[ "$stored" != "$served" ]]; then
    echo "OpenBao serves a certificate ending ${served#notAfter=}, but its $OPENBAO_TLS_SECRET Secret holds one ending"
    echo "${stored#notAfter=}: the reload sidecar hasn't loaded the renewed one. Restart the vault to load it (it unseals again"
    echo "by itself): kubectl -n $OPENBAO_NAMESPACE delete pod $OPENBAO_POD"
  fi
}

# Says what becomes of the configuration keyring when release $1 is uninstalled, from the Secret as it is before the uninstall (the chart's name for it,
# which is derived from the recorded release, not from --namespace). Without OpenBao the Secret is the chart's, and Helm keeps it
# (helm.sh/resource-policy: keep), as does this script. With OpenBao it belongs to an ExternalSecret and goes with the release; the keyring itself is the
# vault's KV secret, which stays in a vault of your own and is removed with one this script installed.
function reportConfigKeyring() {
  local release=$1 fullname=$1 secret owners
  if [[ "$release" != *server* ]]; then
    fullname="$release-server"
  fi
  secret="$fullname-config-keyring"
  if ! kubectl -n "$release" get secret "$secret" >/dev/null 2>&1; then
    return 0
  fi
  owners=`kubectl -n "$release" get secret "$secret" -o jsonpath='{.metadata.ownerReferences[*].kind}' 2>/dev/null`
  if [[ "$owners" == *ExternalSecret* ]]; then
    echo "The configuration keyring Secret $secret goes with the release; the keyring is OpenBao's secret $OPENBAO_KV_MOUNT/$fullname/config-keyring, which"
    echo "stays in a vault of your own and is removed with one this script installed (below): a database you keep can't be read without it."
  else
    echo "Keeping the configuration keyring Secret $secret in namespace $release, as Helm does: a database you keep can't be read without it. To remove it too:"
    echo "  kubectl -n $release delete secret $secret"
  fi
}

# ---------------------------------------------------------------------------------------------------------------------------------------
# DNS publishing (restapi's specs/dns_publishing_and_integrations.md, 6.4, 8, 9.5 and 12)
# ---------------------------------------------------------------------------------------------------------------------------------------

# Succeeds when $1 is an IPv4 or IPv6 literal of a global unicast address, by the rule the server applies to dns.publicAddresses
# (restapi's isGlobalUnicastAddress): never "this network", private, shared (CGNAT), loopback, link-local, benchmarking, protocol
# assignment, multicast or reserved IPv4; never the IPv6 unspecified, loopback, IPv4-mapped, local-use NAT64, unique local, link-local or
# multicast ranges.
function isGlobalUnicast() {
  local ip=${1,,} octet='(0|[1-9][0-9]{0,2})'
  if [[ "$ip" =~ ^$octet\.$octet\.$octet\.$octet$ ]]; then
    local a=${BASH_REMATCH[1]} b=${BASH_REMATCH[2]} c=${BASH_REMATCH[3]} d=${BASH_REMATCH[4]}
    (( a > 255 || b > 255 || c > 255 || d > 255 )) && return 1
    (( a == 0 || a == 10 || a == 127 || a >= 224 )) && return 1
    (( a == 100 && b >= 64 && b <= 127 )) && return 1
    (( a == 169 && b == 254 )) && return 1
    (( a == 172 && b >= 16 && b <= 31 )) && return 1
    (( a == 192 && b == 0 && c == 0 )) && return 1
    (( a == 192 && b == 168 )) && return 1
    (( a == 198 && (b == 18 || b == 19) )) && return 1
    return 0
  fi
  [[ "$ip" == *:* && "$ip" =~ ^[0-9a-f:.]+$ ]] || return 1
  # An IPv4 address in the last 32 bits becomes two groups.
  if [[ "$ip" =~ ^(.*:)$octet\.$octet\.$octet\.$octet$ ]]; then
    (( BASH_REMATCH[2] > 255 || BASH_REMATCH[3] > 255 || BASH_REMATCH[4] > 255 || BASH_REMATCH[5] > 255 )) && return 1
    ip=`printf '%s%x:%x' "${BASH_REMATCH[1]}" $(( BASH_REMATCH[2] * 256 + BASH_REMATCH[3] )) $(( BASH_REMATCH[4] * 256 + BASH_REMATCH[5] ))`
  fi
  [[ "$ip" != *.* && "$ip" != *::*::* && "$ip" != *:::* ]] || return 1
  local left=$ip right="" head tail groups=() g
  if [[ "$ip" == *::* ]]; then
    left=${ip%%::*}
    right=${ip#*::}
  fi
  IFS=: read -r -a head <<< "$left"
  IFS=: read -r -a tail <<< "$right"
  if [[ "$ip" == *::* ]]; then
    local fill=$(( 8 - ${#head[@]} - ${#tail[@]} ))
    (( fill >= 1 )) || return 1
    groups=("${head[@]}")
    while (( fill > 0 )); do groups+=(0); fill=$(( fill - 1 )); done
    groups+=("${tail[@]}")
  else
    groups=("${head[@]}")
  fi
  (( ${#groups[@]} == 8 )) || return 1
  for g in "${!groups[@]}"; do
    [[ "${groups[g]}" =~ ^[0-9a-f]{1,4}$ ]] || return 1
    groups[g]=$(( 16#${groups[g]} ))
  done
  # ::/96 (unspecified, loopback, IPv4-compatible) and ::ffff:0:0/96 (IPv4-mapped)
  if (( groups[0] == 0 && groups[1] == 0 && groups[2] == 0 && groups[3] == 0 && groups[4] == 0 && (groups[5] == 0 || groups[5] == 65535) )); then
    return 1
  fi
  (( groups[0] == 100 && groups[1] == 65435 && groups[2] == 1 )) && return 1
  (( (groups[0] & 65024) == 64512 )) && return 1
  (( (groups[0] & 65472) == 65152 )) && return 1
  (( (groups[0] & 65280) == 65280 )) && return 1
  return 0
}

# --public-address: adds $1 to the addresses the mail host is published at, each once. The server refuses any that is not global unicast,
# so this does first, before anything is installed.
function addPublicAddress() {
  local address=$1 existing
  if ! isGlobalUnicast "$address"; then
    echo "--public-address $address isn't a public (global unicast) address: private, loopback, link-local and shared (CGNAT) addresses can't be published."
    exit 1
  fi
  for existing in "${PUBLIC_ADDRESSES[@]}"; do
    if [[ "${existing,,}" == "${address,,}" ]]; then
      return 0
    fi
  done
  PUBLIC_ADDRESSES+=("$address")
}

# The addresses the mail host's A/AAAA records point at (restapi 6.4): those given with --public-address, else the node's global unicast IPv4
# addresses (not the temporary or deprecated ones, which are for outgoing connections), and, when it has no public IPv4 address (NAT, a cloud's
# private network), the one the outside world sees it as. A global IPv6 address is not published unless it is given: this script installs k3s
# single-stack, whose service load balancer takes the mail ports over IPv4 only, so a AAAA record for the mail host (which is also the MX target)
# would make IPv6 mail servers and clients try an address nothing listens on before falling back. It says what it found. None is not fatal: the
# hosts are then published by hand.
function detectPublicAddresses() {
  if [[ ${#PUBLIC_ADDRESSES[@]} -gt 0 ]]; then
    echo "Publishing the mail host at the public addresses you gave: ${PUBLIC_ADDRESSES[*]}"
    return 0
  fi
  local line fields i address has4=false
  UNPUBLISHED_IPV6=()
  if command -v ip >/dev/null 2>&1; then
    while IFS= read -r line || [[ -n "$line" ]]; do
      case "$line" in
        *temporary*|*deprecated*|*tentative*) continue;;
      esac
      read -r -a fields <<< "$line"
      for (( i = 0; i < ${#fields[@]} - 1; i++ )); do
        case "${fields[i]}" in
          inet|inet6)
            address=${fields[i+1]%%/*}
            if isGlobalUnicast "$address"; then
              if [[ "${fields[i]}" == inet ]]; then
                has4=true
                addPublicAddress "$address"
              else
                UNPUBLISHED_IPV6+=("$address")
              fi
            fi
            ;;
        esac
      done
    done < <(ip -o addr show scope global 2>/dev/null)
  fi
  if [[ "$has4" != "true" ]]; then
    address=`curl -4 -fsS --max-time 10 "$PUBLIC_IPV4_URL" 2>/dev/null | tr -d '[:space:]'`
    if [[ "$address" != *:* ]] && isGlobalUnicast "$address"; then
      addPublicAddress "$address"
    fi
  fi
  if [[ ${#UNPUBLISHED_IPV6[@]} -gt 0 ]]; then
    echo "This machine has the IPv6 address(es) ${UNPUBLISHED_IPV6[*]}. They are not published: the mail ports are reachable over IPv4 only here."
    echo "Pass one with --public-address <ip> if your cluster listens on IPv6 as well."
  fi
  if [[ ${#PUBLIC_ADDRESSES[@]} -eq 0 ]]; then
    echo "No public IPv4 address was found on this machine or from outside, so the A/AAAA records of $SERVER_HOST can't be published. Pass the address"
    echo "with --public-address <ip> (repeatable), or add the records yourself."
    return 0
  fi
  echo "Detected the public address(es) of this machine: ${PUBLIC_ADDRESSES[*]}. These are what $SERVER_HOST is published at;"
  echo "pass --public-address <ip> (repeatable) to publish others."
}

# $1 as a JSON string: quoted, with quotes, backslashes and control characters escaped.
function jsonString() {
  local value=$1 out="" i c code hex
  for (( i = 0; i < ${#value}; i++ )); do
    c=${value:i:1}
    case "$c" in
      '"') out+='\"';;
      '\') out+='\\';;
      $'\n') out+='\n';;
      $'\r') out+='\r';;
      $'\t') out+='\t';;
      *)
        printf -v code '%d' "'$c"
        if (( code < 32 )); then
          printf -v hex '\\u%04x' "$code"
          out+=$hex
        else
          out+=$c
        fi
        ;;
    esac
  done
  printf '"%s"' "$out"
}

# A comma-separated list ($1) as a JSON array of strings.
function jsonList() {
  local items=() item out="" first=true
  IFS=, read -r -a items <<< "$1"
  for item in "${items[@]}"; do
    item=${item#"${item%%[![:space:]]*}"}
    item=${item%"${item##*[![:space:]]}"}
    if [[ -z "$item" ]]; then
      continue
    fi
    if [[ "$first" != "true" ]]; then
      out+=","
    fi
    out+=`jsonString "$item"`
    first=false
  done
  printf '[%s]' "$out"
}

# What each provider type reads, as <variable> <secret|option> <the server's key> <str|list|int|bool|file> <required yes|no> per line. A secret
# becomes a file of the Secret $FULLNAME-dns-bootstrap (and so a credential on the provider config); an option goes into the config the chart is given.
# The variables are the provider's own (Cloudflare's CF_API_TOKEN, AWS's keys, Azure's service principal) or external-dns's (EXTERNAL_DNS_<flag>).
function dnsProviderVariables() {
  case "$1" in
    cloudflare)
      echo "CF_API_TOKEN secret apiToken str yes";;
    route53)
      echo "AWS_ACCESS_KEY_ID secret accessKeyId str no"
      echo "AWS_SECRET_ACCESS_KEY secret secretAccessKey str no"
      echo "AWS_REGION option region str yes"
      echo "EXTERNAL_DNS_AWS_ZONE_TYPE option zoneType str no"
      echo "EXTERNAL_DNS_AWS_ASSUME_ROLE option assumeRoleArn str no";;
    rfc2136)
      echo "EXTERNAL_DNS_RFC2136_TSIG_SECRET secret tsigSecret str no"
      echo "EXTERNAL_DNS_RFC2136_HOST option hosts list yes"
      echo "EXTERNAL_DNS_RFC2136_PORT option port int no"
      echo "EXTERNAL_DNS_RFC2136_ZONE option zone str no"
      echo "EXTERNAL_DNS_RFC2136_TSIG_KEYNAME option tsigKeyName str no"
      echo "EXTERNAL_DNS_RFC2136_TSIG_SECRET_ALG option tsigAlgorithm str no"
      echo "EXTERNAL_DNS_RFC2136_INSECURE option insecure bool no";;
    google)
      echo "GOOGLE_APPLICATION_CREDENTIALS secret serviceAccountJson file yes"
      echo "EXTERNAL_DNS_GOOGLE_PROJECT option project str yes";;
    azure)
      echo "AZURE_CLIENT_ID secret clientId str yes"
      echo "AZURE_CLIENT_SECRET secret clientSecret str yes"
      echo "AZURE_TENANT_ID option tenantId str yes"
      echo "AZURE_SUBSCRIPTION_ID option subscriptionId str yes"
      echo "AZURE_RESOURCE_GROUP option resourceGroup str yes";;
  esac
}

# The name the provider config is shown under in the admin console.
function dnsProviderLabel() {
  case "$1" in
    cloudflare) echo "Cloudflare";;
    route53) echo "Route 53";;
    rfc2136) echo "RFC 2136";;
    google) echo "Google Cloud DNS";;
    azure) echo "Azure DNS";;
  esac
}

# Reads the provider's credentials and options (dnsProviderVariables) into DNS_SECRETS and DNS_OPTIONS (by the server's keys): from the
# KEY=value lines of --dns-credentials-file, which is read as text and never run, and from the environment for what the file doesn't set.
# Nothing is taken from a command line, where any local user could read it. It stops the install, naming the variable and never its value,
# when something is missing or has the wrong form; the server checks the rest with the console's rules when it creates the config.
function loadDnsCredentials() {
  declare -gA DNS_SECRETS=()
  declare -gA DNS_OPTIONS=()
  declare -gA DNS_OPTION_KINDS=()
  declare -ga DNS_OPTION_ORDER=()
  local -A fromFile=()
  local known=" " variable role key kind required value line number=0 name
  if [[ "$DNS_PROVIDER" == "cloudflare" ]]; then
    # Not a setting: the zone's id, which prepareDns asks Cloudflare for with the token (a token scoped to one zone can't list the others).
    DNS_OPTION_KINDS[zoneIds]=list
    DNS_OPTION_ORDER+=(zoneIds)
  fi
  while read -r variable role key kind required; do
    known+="$variable "
    if [[ "$role" == "option" ]]; then
      DNS_OPTION_KINDS[$key]=$kind
      DNS_OPTION_ORDER+=("$key")
    fi
  done < <(dnsProviderVariables "$DNS_PROVIDER")
  if [[ -n "$DNS_CREDENTIALS_FILE" ]]; then
    while IFS= read -r line || [[ -n "$line" ]]; do
      number=$(( number + 1 ))
      line=${line%$'\r'}
      line=${line#"${line%%[![:space:]]*}"}
      if [[ -z "$line" || "$line" == \#* ]]; then
        continue
      fi
      if [[ ! "$line" =~ ^(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=(.*)$ ]]; then
        echo "$DNS_CREDENTIALS_FILE, line $number: expected NAME=value, a comment or an empty line."
        exit 1
      fi
      name=${BASH_REMATCH[2]}
      value=${BASH_REMATCH[3]}
      value=${value%"${value##*[![:space:]]}"}
      if [[ ${#value} -ge 2 && ( "${value:0:1}" == '"' || "${value:0:1}" == "'" ) && "${value: -1}" == "${value:0:1}" ]]; then
        value=${value:1:${#value}-2}
      fi
      if [[ "$known" != *" $name "* ]]; then
        echo "$DNS_CREDENTIALS_FILE, line $number: $name isn't a setting of a $DNS_PROVIDER provider (it reads:${known% })."
        exit 1
      fi
      fromFile[$name]=$value
    done < "$DNS_CREDENTIALS_FILE"
  fi
  while read -r variable role key kind required; do
    if [[ -n "${fromFile[$variable]+set}" ]]; then
      value=${fromFile[$variable]}
    else
      value=${!variable}
    fi
    if [[ -z "$value" ]]; then
      if [[ "$required" == "yes" ]]; then
        echo "A $DNS_PROVIDER provider needs $variable: set it in the environment, or as $variable=<value> in the file --dns-credentials-file names (never on the command line)."
        exit 1
      fi
      continue
    fi
    case "$kind" in
      file)
        if [[ ! -f "$value" || ! -r "$value" ]]; then
          echo "$variable names a file that can't be read."
          exit 1
        fi
        value=`cat "$value"`
        ;;
      int)
        if [[ ! "$value" =~ ^[0-9]{1,5}$ ]]; then
          echo "$variable must be a number."
          exit 1
        fi
        value=$(( 10#$value ))
        ;;
      bool)
        value=${value,,}
        if [[ "$value" != "true" && "$value" != "false" ]]; then
          echo "$variable must be true or false."
          exit 1
        fi
        ;;
    esac
    if [[ "$kind" != "file" && "$value" =~ [[:cntrl:]] ]]; then
      echo "$variable has a control character (a line break, most likely)."
      exit 1
    fi
    if [[ "$role" == "secret" ]]; then
      DNS_SECRETS[$key]=$value
    else
      DNS_OPTIONS[$key]=$value
    fi
  done < <(dnsProviderVariables "$DNS_PROVIDER")
  if [[ "$DNS_PROVIDER" == "cloudflare" && ! "${DNS_SECRETS[apiToken]}" =~ ^[A-Za-z0-9._~+/=-]+$ ]]; then
    # It goes into a request header.
    echo "CF_API_TOKEN isn't made of the characters a Cloudflare API token has (letters, digits and - _ . ~ + / =)."
    exit 1
  fi
  if [[ "$DNS_PROVIDER" == "route53" && -n "${DNS_SECRETS[accessKeyId]}${DNS_SECRETS[secretAccessKey]}" && ( -z "${DNS_SECRETS[accessKeyId]}" || -z "${DNS_SECRETS[secretAccessKey]}" ) ]]; then
    echo "AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be set together, or neither (external-dns then uses the role of its service account)."
    exit 1
  fi
  if [[ "$DNS_PROVIDER" == "rfc2136" ]]; then
    if [[ -z "${DNS_OPTIONS[zone]}" ]]; then
      DNS_OPTIONS[zone]=$DNS_ZONE
    fi
    if [[ "${DNS_OPTIONS[insecure]}" != "true" && ( -z "${DNS_OPTIONS[tsigKeyName]}" || -z "${DNS_SECRETS[tsigSecret]}" ) ]]; then
      echo "A rfc2136 provider needs EXTERNAL_DNS_RFC2136_TSIG_KEYNAME and EXTERNAL_DNS_RFC2136_TSIG_SECRET, or EXTERNAL_DNS_RFC2136_INSECURE=true for unsigned updates."
      exit 1
    fi
  fi
}

# Succeeds when host name $2 is zone $1 or inside it.
function dnsZoneCovers() {
  [[ "${2,,}" == "${1,,}" || "${2,,}" == *".${1,,}" ]]
}

# Prints the id of Cloudflare's zone $1, asked with the token (in a request configuration on stdin, not an argument, which any local user could
# read in the process list). Returns 3 for no such zone (with $2 = quiet, without saying so) and 1 when Cloudflare can't be asked or refuses.
function cloudflareZoneId() {
  local zone=$1 response message id
  response=$(printf 'header = "Authorization: Bearer %s"\n' "${DNS_SECRETS[apiToken]}" | curl -sS --max-time 30 -K - "https://api.cloudflare.com/client/v4/zones?name=$zone" 2>/dev/null)
  if [[ -z "$response" ]]; then
    echo "Cloudflare could not be asked for the zone $zone (no answer, or it refused the request). Check the network and the token." >&2
    return 1
  fi
  if ! grep -Eq '"success": *true' <<< "$response"; then
    message=`sed -n 's/.*"errors": *\[ *{[^}]*"message": *"\([^"]*\)".*/\1/p' <<< "$response"`
    echo "Cloudflare refused the lookup of the zone $zone${message:+: $message}. The token needs Zone:Zone:Read and Zone:DNS:Edit on the zone." >&2
    return 1
  fi
  id=`sed -n 's/.*"result": *\[ *{ *"id": *"\([0-9a-f]\{32\}\)".*/\1/p' <<< "$response"`
  if [[ -z "$id" ]]; then
    if [[ "$2" != "quiet" ]]; then
      echo "Cloudflare has no zone $zone for this token." >&2
    fi
    return 3
  fi
  echo "$id"
}

# The distinct domains the server seeds (the chart's mail.domains default): --domain and each of --mail-domains, lowercase, one per line.
function seedDomains() {
  local domains=() domain seen=" "
  IFS=, read -r -a domains <<< "$DOMAIN,$MAIL_DOMAINS"
  for domain in "${domains[@]}"; do
    domain=${domain,,}
    domain=${domain//[[:space:]]/}
    if [[ -n "$domain" && "$seen" != *" $domain "* ]]; then
      seen+="$domain "
      echo "$domain"
    fi
  done
}

# Everything --dns-provider needs before anything is installed: the zone (--dns-zone, else --domain's, which for Cloudflare is the one its API
# has, looking from --domain upwards), the credentials, Cloudflare's zone id and the public addresses. It stops the install on what can't work,
# and says which domains the zone doesn't contain: their records stay with the administrator, as the server leaves a domain outside the
# provider's zones manual.
function prepareDns() {
  if [[ -z "$DNS_PROVIDER" ]]; then
    return 0
  fi
  local label domain candidate id status
  label=`dnsProviderLabel "$DNS_PROVIDER"`
  if [[ "$DOMAIN" == "cluster.local" || "$DOMAIN" == "localhost" || "$DOMAIN" =~ \.(local|localhost)$ ]]; then
    echo "--dns-provider needs --domain: a public domain the DNS zone contains."
    exit 1
  fi
  if [[ -n "$DNS_ZONE" ]]; then
    DNS_ZONE=${DNS_ZONE,,}
    DNS_ZONE=${DNS_ZONE%.}
    if [[ ! "$DNS_ZONE" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]]; then
      echo "--dns-zone must be a domain name of at least two labels, such as example.com."
      exit 1
    fi
    if ! dnsZoneCovers "$DNS_ZONE" "$DOMAIN"; then
      echo "--dns-zone $DNS_ZONE doesn't contain --domain $DOMAIN: the zone is the domain itself or a parent of it."
      exit 1
    fi
  elif [[ "$DNS_PROVIDER" != "cloudflare" ]]; then
    DNS_ZONE=${DOMAIN,,}
    DNS_ZONE=${DNS_ZONE%.}
  fi
  loadDnsCredentials
  if [[ "$DNS_PROVIDER" == "cloudflare" ]]; then
    if [[ -n "$DNS_ZONE" ]]; then
      id=`cloudflareZoneId "$DNS_ZONE"` || exit 1
    else
      # The zone is the most specific name from --domain upwards that Cloudflare has for this token, down to two labels.
      candidate=${DOMAIN,,}
      candidate=${candidate%.}
      while true; do
        id=`cloudflareZoneId "$candidate" quiet`
        status=$?
        if [[ $status -eq 0 ]]; then
          DNS_ZONE=$candidate
          break
        elif [[ $status -ne 3 ]]; then
          exit 1
        fi
        candidate=${candidate#*.}
        if [[ "$candidate" != *.* ]]; then
          echo "Cloudflare has no zone for $DOMAIN or any name above it that this token can see. Check the token, or name the zone with --dns-zone."
          exit 1
        fi
      done
    fi
    DNS_OPTIONS[zoneIds]=$id
  fi
  echo "Publishing DNS records through $label for the zone $DNS_ZONE."
  if [[ "$DNS_TAKEOVER" == "true" ]]; then
    echo "--dns-takeover: records that already exist at the names RapidMX publishes are replaced."
  fi
  for domain in `seedDomains`; do
    if ! dnsZoneCovers "$DNS_ZONE" "$domain"; then
      echo "$domain is outside the zone $DNS_ZONE, so its records are published by hand (the admin console lists them)."
    fi
  done
  detectPublicAddresses
}

# The provider config the server creates when it first starts (mail:dns:bootstrap_provider), as JSON: { name, type, zones, options, allowTakeover }.
function dnsBootstrapProviderJson() {
  local key value item out first=true takeover=false
  if [[ "$DNS_TAKEOVER" == "true" ]]; then
    takeover=true
  fi
  out="{\"name\":`jsonString "\`dnsProviderLabel "$DNS_PROVIDER"\` (installer)"`,\"type\":`jsonString "$DNS_PROVIDER"`,\"zones\":[`jsonString "$DNS_ZONE"`],\"options\":{"
  for key in "${DNS_OPTION_ORDER[@]}"; do
    if [[ -z "${DNS_OPTIONS[$key]+set}" ]]; then
      continue
    fi
    value=${DNS_OPTIONS[$key]}
    case "${DNS_OPTION_KINDS[$key]}" in
      list) item=`jsonList "$value"`;;
      int|bool) item=$value;;
      *) item=`jsonString "$value"`;;
    esac
    if [[ "$first" != "true" ]]; then
      out+=","
    fi
    out+="`jsonString "$key"`:$item"
    first=false
  done
  out+="},\"allowTakeover\":$takeover}"
  printf '%s\n' "$out"
}

# The Secret the server pod reads the credentials from, once, when it creates the provider config (mount optional, server pods only; the chart's
# dns.bootstrapProvider): one key per credential. Nothing when the provider needs none (Route 53 through the role of external-dns's service account).
function dnsBootstrapSecretManifest() {
  local key encoded
  if [[ ${#DNS_SECRETS[@]} -eq 0 ]]; then
    return 0
  fi
  printf 'apiVersion: v1\nkind: Secret\nmetadata:\n  name: %s\n  namespace: %s\ntype: Opaque\ndata:\n' "$FULLNAME-dns-bootstrap" "$NAMESPACE"
  while read -r key; do
    encoded=`printf '%s' "${DNS_SECRETS[$key]}" | base64 | tr -d '\n'`
    printf "  %s: '%s'\n" "$key" "$encoded"
  done < <(printf '%s\n' "${!DNS_SECRETS[@]}" | sort)
}

# Creates that Secret before the release, in a namespace made first, through stdin: the credentials are never an argument.
function createDnsBootstrapSecret() {
  local manifest
  manifest=`dnsBootstrapSecretManifest`
  if [[ -z "$manifest" ]]; then
    return 0
  fi
  kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
  # What the server says from now on is what it said about this Secret (finishDnsBootstrap).
  DNS_SECRET_APPLIED_AT=`date -u +%Y-%m-%dT%H:%M:%SZ`
  if ! printf '%s\n' "$manifest" | kubectl apply -f - >/dev/null; then
    echo "There was a problem saving the DNS credentials for the server."
    exit 1
  fi
  echo "The DNS credentials are in the Secret $FULLNAME-dns-bootstrap, which is deleted once the server has stored them."
}

# The values the chart is given for DNS (the part of the values file, YAML): publishing on, the addresses, the provider config for the server
# to create, and the controller's release when it is named. Nothing secret: the credentials are in the Secret.
function dnsHelmValues() {
  local addresses="" address
  if [[ -z "$DNS_PROVIDER" ]]; then
    return 0
  fi
  for address in "${PUBLIC_ADDRESSES[@]}"; do
    addresses+="${addresses:+, }`jsonString "$address"`"
  done
  printf 'dns:\n  publishing:\n    enabled: true\n  publicAddresses: [%s]\n  bootstrapProvider: %s\n' "$addresses" "`dnsBootstrapProviderJson`"
  if [[ -n "$DNS_CONTROLLER_TAG" || -n "$DNS_CONTROLLER_DIGEST" ]]; then
    printf '  controller:\n    image:\n'
    if [[ -n "$DNS_CONTROLLER_TAG" ]]; then
      printf '      tag: %s\n' "`yamlQuote "$DNS_CONTROLLER_TAG"`"
    fi
    if [[ -n "$DNS_CONTROLLER_DIGEST" ]]; then
      printf '      digest: %s\n' "`yamlQuote "$DNS_CONTROLLER_DIGEST"`"
    fi
  fi
}

# What the server last said about the provider config since the Secret was made ($DNS_SECRET_APPLIED_AT: its log from before is about an earlier
# Secret), one line, from the log of all its pods.
function dnsBootstrapOutcome() {
  kubectl -n "$NAMESPACE" logs -l "app.kubernetes.io/instance=$FULLNAME-services" --all-containers=true --tail=-1 ${DNS_SECRET_APPLIED_AT:+--since-time="$DNS_SECRET_APPLIED_AT"} 2>/dev/null \
    | grep -E 'Created the DNS provider|installer configured already exists|installer configured was created on an earlier start|installer configured was not created|installer configured could not be created' | tail -n 1
}

# After the release is installed: waits for the server to be ready (it creates the provider config before it reports ready) and deletes the
# Secret with the credentials once the server's log says the config exists, so the database is the only place they stay. A Secret the server
# could not read, or whose outcome can't be found in the log, is kept, with the command that deletes it. The server reads the Secret only when it
# starts, and a run that changes nothing in the release (the same flags again, a new token) leaves its pods running, with a log from before this
# Secret: when the log has nothing since the Secret was made, the server is restarted so that it reads this one.
function finishDnsBootstrap() {
  local secret="$FULLNAME-dns-bootstrap" line
  if ! kubectl -n "$NAMESPACE" get secret "$secret" >/dev/null 2>&1; then
    return 0
  fi
  echo "Waiting for the server to start, which stores the DNS credentials of the Secret $secret..."
  if ! kubectl -n "$NAMESPACE" rollout status "deployment/$FULLNAME-services" --timeout="$DNS_ROLLOUT_TIMEOUT"; then
    echo "The server isn't ready yet, so it isn't known whether it stored the DNS credentials. The Secret $secret was kept. Once the server is ready and"
    echo "its log says it created the DNS provider, delete it:"
    echo "  kubectl -n $NAMESPACE delete secret $secret"
    return 0
  fi
  line=`dnsBootstrapOutcome`
  if [[ -z "$line" ]]; then
    echo "The server hasn't said anything about the Secret $secret: its pods started before it was made. Restarting them to have them read it..."
    kubectl -n "$NAMESPACE" rollout restart "deployment/$FULLNAME-services" >/dev/null
    if kubectl -n "$NAMESPACE" rollout status "deployment/$FULLNAME-services" --timeout="$DNS_ROLLOUT_TIMEOUT"; then
      line=`dnsBootstrapOutcome`
    fi
  fi
  case "$line" in
    *"Created the DNS provider"*)
      kubectl -n "$NAMESPACE" delete secret "$secret" >/dev/null
      echo "The server stored the DNS credentials, encrypted, in its database; the Secret $secret was deleted."
      ;;
    *"already exists"*|*"on an earlier start"*)
      DNS_CONFIG_EXISTED=true
      kubectl -n "$NAMESPACE" delete secret "$secret" >/dev/null
      echo "The DNS provider already exists (an earlier install created it), so these credentials and the provider options (--dns-zone, --dns-takeover) were"
      echo "not applied to it: they are changed in the admin console. The Secret $secret was deleted."
      ;;
    *"not created"*|*"could not be created"*)
      echo "The server could not create the DNS provider, so no records are published until it has:"
      echo "  $line"
      echo "The Secret $secret was kept for its next start. Once the provider exists, or to give up on it, delete the Secret:"
      echo "  kubectl -n $NAMESPACE delete secret $secret"
      ;;
    *)
      echo "Whether the server stored the DNS credentials could not be confirmed from its log, so the Secret $secret was kept. Once the admin console"
      echo "lists the DNS provider (Integrations), delete it:"
      echo "  kubectl -n $NAMESPACE delete secret $secret"
      ;;
  esac
}

# Waits for the DNS controller; a controller that isn't ready is said, not fatal: the release is installed, and it publishes when it is.
function waitForDnsController() {
  if ! kubectl -n "$NAMESPACE" rollout status "deployment/$FULLNAME-dns-controller" --timeout="$DNS_ROLLOUT_TIMEOUT"; then
    echo "The DNS controller ($FULLNAME-dns-controller) isn't ready yet. Look at it with:"
    echo "  kubectl -n $NAMESPACE get pods -l app=dns-controller"
    echo "  kubectl -n $NAMESPACE logs deployment/$FULLNAME-dns-controller"
  fi
}

# The DNSEndpoint CRD of external-dns v0.23.0 (config/crd/standard/dnsendpoints.externaldns.k8s.io.yaml), the same as
# deploy/crds/dnsendpoints.externaldns.k8s.io.yaml (a test keeps them equal). It is here as well because this script is downloaded on its own.
function dnsEndpointCrd() {
  cat << 'EOF'
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  annotations:
    api-approved.kubernetes.io: https://github.com/kubernetes-sigs/external-dns/pull/2007
    controller-gen.kubebuilder.io/version: v0.21.0
  name: dnsendpoints.externaldns.k8s.io
spec:
  group: externaldns.k8s.io
  names:
    kind: DNSEndpoint
    listKind: DNSEndpointList
    plural: dnsendpoints
    singular: dnsendpoint
  scope: Namespaced
  versions:
    - name: v1alpha1
      schema:
        openAPIV3Schema:
          description: |-
            DNSEndpoint is a contract that a user-specified CRD must implement to be used as a source for external-dns.
            The user-specified CRD should also have the status sub-resource.
          properties:
            apiVersion:
              description: |-
                APIVersion defines the versioned schema of this representation of an object.
                Servers should convert recognized schemas to the latest internal value, and
                may reject unrecognized values.
                More info: https://git.k8s.io/community/contributors/devel/sig-architecture/api-conventions.md#resources
              type: string
            kind:
              description: |-
                Kind is a string value representing the REST resource this object represents.
                Servers may infer this from the endpoint the client submits requests to.
                Cannot be updated.
                In CamelCase.
                More info: https://git.k8s.io/community/contributors/devel/sig-architecture/api-conventions.md#types-kinds
              type: string
            metadata:
              type: object
            spec:
              description: DNSEndpointSpec defines the desired state of DNSEndpoint
              properties:
                endpoints:
                  items:
                    description: Endpoint is a high-level way of a connection between a service and an IP
                    properties:
                      dnsName:
                        description: The hostname of the DNS record
                        type: string
                      labels:
                        additionalProperties:
                          type: string
                        description: Labels stores labels defined for the Endpoint
                        type: object
                      providerSpecific:
                        description: ProviderSpecific stores provider specific config
                        items:
                          description: ProviderSpecificProperty holds the name and value of a configuration which is specific to individual DNS providers
                          properties:
                            name:
                              type: string
                            value:
                              type: string
                          type: object
                        type: array
                      recordTTL:
                        description: TTL for the record
                        format: int64
                        type: integer
                      recordType:
                        description: RecordType type of record, e.g. CNAME, A, AAAA, SRV, TXT etc
                        type: string
                      setIdentifier:
                        description: Identifier to distinguish multiple records with the same name and type (e.g. Route53 records with routing policies other than 'simple')
                        type: string
                      targets:
                        description: The targets the DNS record points to
                        items:
                          type: string
                        type: array
                    type: object
                  type: array
              type: object
            status:
              description: DNSEndpointStatus defines the observed state of DNSEndpoint
              properties:
                observedGeneration:
                  description: The generation observed by the external-dns controller.
                  format: int64
                  type: integer
              type: object
          type: object
      served: true
      storage: true
      subresources:
        status: {}
EOF
}

# Installs that CRD, which is cluster-scoped and so not the chart's (like cert-manager's): when the cluster has none, or when this script
# installed it, so a newer copy is picked up. A CRD another installation made is left as it is. Recorded, so --uninstall removes only that.
function installDnsCrd() {
  local isNew=false
  if kubectl get crd "$DNS_CRD_NAME" >/dev/null 2>&1; then
    if [[ "`installedBy dns_crd`" != "true" ]]; then
      echo "The DNSEndpoint CRD is already installed; leaving it as it is."
      return 0
    fi
  else
    isNew=true
  fi
  if ! dnsEndpointCrd | kubectl apply --server-side=true -f - >/dev/null; then
    echo "There was a problem installing the DNSEndpoint CRD (external-dns's)."
    exit 1
  fi
  if ! kubectl wait --for=condition=Established "crd/$DNS_CRD_NAME" --timeout=2m >/dev/null; then
    echo "The DNSEndpoint CRD was applied but did not become established."
    exit 1
  fi
  if [[ "$isNew" == "true" ]]; then
    recordInstalled dns_crd
  fi
}

# The addresses of DNS name $1 for record type $2 (A, AAAA, CNAME, MX, SRV), asked of the zone's own name server when there is a way to find it,
# so a recursive resolver's cache neither hides a record that was just published nor keeps one that was just removed.
function dnsLookup() {
  local server=""
  if command -v dig >/dev/null 2>&1; then
    if [[ -n "$DNS_ZONE" ]]; then
      server=`dig +short +time=3 +tries=1 NS "$DNS_ZONE" 2>/dev/null | head -n 1`
    fi
    dig +short +time=3 +tries=1 ${server:+"@$server"} "$1" "$2" 2>/dev/null
  elif command -v getent >/dev/null 2>&1; then
    case "$2" in
      A) getent ahostsv4 "$1" | awk '{ print $1 }' | sort -u;;
      AAAA) getent ahostsv6 "$1" | awk '{ print $1 }' | sort -u;;
    esac
  fi
}

# Succeeds when DNS name $1 leads to this server: an address of it is one of the public addresses, or one of $SERVER_HOST's, or it is a CNAME for
# $SERVER_HOST.
function resolvesToServer() {
  local mine=("${PUBLIC_ADDRESSES[@]}") type answer own
  for type in A AAAA; do
    for own in `dnsLookup "$SERVER_HOST" "$type"`; do
      mine+=("$own")
    done
  done
  for type in A AAAA; do
    for answer in `dnsLookup "$1" "$type"`; do
      answer=${answer%.}
      if [[ "${answer,,}" == "${SERVER_HOST,,}" ]]; then
        return 0
      fi
      for own in "${mine[@]}"; do
        if [[ "${answer,,}" == "${own,,}" ]]; then
          return 0
        fi
      done
    done
  done
  return 1
}

# Runs helm or kubectl ($1, with the arguments after it) against this installation's cluster for the checks that come before the cluster is set up,
# as decideOpenpgpkeyHost and checkDnsDomainsAssigned do: with the kubeconfig the later steps will use, and failing, not stopping the install, when
# there is no such tool or cluster yet (a first install).
function clusterTool() {
  local tool=$1
  shift
  if ! command -v "$tool" >/dev/null 2>&1; then
    return 1
  fi
  if [[ -z "$KUBECONFIG" && -f "$USER_KUBECONFIG" ]]; then
    KUBECONFIG="$USER_KUBECONFIG" "$tool" "$@"
  else
    "$tool" "$@"
  fi
}

# Whether the domains this run seeds end up on the installer's DNS provider, which is what makes the controller publish their records. The server
# creates a domain only when it is absent and never changes one that exists (restapi 13.3), so adding --dns-provider to a release that wasn't
# publishing leaves the domains it already has manual: they are assigned to the provider in the admin console, on the domain's DNS panel. A new
# release, and one that was publishing already, have them assigned. Sets DNS_DOMAINS_ASSIGNED.
function checkDnsDomainsAssigned() {
  DNS_DOMAINS_ASSIGNED=true
  if [[ -z "$DNS_PROVIDER" ]]; then
    return 0
  fi
  if clusterTool helm status "$NAMESPACE" -n "$NAMESPACE" >/dev/null 2>&1 && ! clusterTool kubectl -n "$NAMESPACE" get deployment "$FULLNAME-dns-controller" >/dev/null 2>&1; then
    DNS_DOMAINS_ASSIGNED=false
  fi
}

# Whether the release this run upgrades serves openpgpkey.<domain> now (the mail.wkd.openpgpkeyHost.enabled it was given).
function openpgpkeyHostServed() {
  clusterTool helm get values "$NAMESPACE" -n "$NAMESPACE" -o json 2>/dev/null | grep -Eq '"openpgpkeyHost": *\{[^}]*"enabled": *true'
}

# Succeeds when DNS name $1 leads to this server, asked up to OPENPGPKEY_LOOKUP_TRIES times: one lost packet isn't an answer.
function resolvesToServerSure() {
  local attempt
  for (( attempt = 1; attempt <= OPENPGPKEY_LOOKUP_TRIES; attempt++ )); do
    if resolvesToServer "$1"; then
      return 0
    fi
    if (( attempt < OPENPGPKEY_LOOKUP_TRIES )); then
      sleep 2
    fi
  done
  return 1
}

# Decides how openpgpkey.<domain> is installed (restapi 12.5): OPENPGPKEY_ON is whether this install serves it, OPENPGPKEY_PENDING that a provider
# will publish its record and it is served by a second step (enableOpenpgpkeyHost), since the Certificate covering it is never issued, and Helm's
# --wait would block, while the name doesn't resolve. true serves it whatever the record says, unless a provider will publish the record. A release
# that serves it already keeps serving it when the lookup says it doesn't resolve (a failed lookup would otherwise drop the host's listeners and the
# name from the server's certificate, to be issued again by the next run); false turns it off. Nothing is pending when the domains aren't on the
# provider (checkDnsDomainsAssigned): nothing would publish the record.
function decideOpenpgpkeyHost() {
  OPENPGPKEY_ON=false
  OPENPGPKEY_PENDING=false
  checkDnsDomainsAssigned
  if [[ "$OPENPGPKEY_HOST" == "false" ]]; then
    return 0
  fi
  if resolvesToServerSure "$OPENPGPKEY_HOSTNAME"; then
    OPENPGPKEY_ON=true
  elif openpgpkeyHostServed; then
    OPENPGPKEY_ON=true
    echo "$OPENPGPKEY_HOSTNAME didn't resolve to this server just now, so it stays served as the release has it (--openpgpkey-host false turns it off)."
  elif [[ -n "$DNS_PROVIDER" && "$DNS_DOMAINS_ASSIGNED" == "true" ]] && dnsZoneCovers "$DNS_ZONE" "$OPENPGPKEY_HOSTNAME"; then
    OPENPGPKEY_PENDING=true
  elif [[ "$OPENPGPKEY_HOST" == "true" ]]; then
    OPENPGPKEY_ON=true
  fi
}

# The second step of that install: once openpgpkey.<domain> resolves to this server (the provider publishes it, which takes a sync interval or
# two), serves it: the Gateway's listeners, then the release with the host on. Waits up to OPENPGPKEY_WAIT_SECONDS; a record that doesn't come is
# said, not fatal, and the next run of this script finishes it.
function enableOpenpgpkeyHost() {
  if [[ "$OPENPGPKEY_PENDING" != "true" ]]; then
    return 0
  fi
  echo "Waiting for $OPENPGPKEY_HOSTNAME to resolve to this server (the DNS controller publishes it) before serving it..."
  local deadline=$(( SECONDS + OPENPGPKEY_WAIT_SECONDS ))
  until resolvesToServer "$OPENPGPKEY_HOSTNAME"; do
    if (( SECONDS >= deadline )); then
      echo "$OPENPGPKEY_HOSTNAME doesn't resolve to this server yet, so it isn't served (its certificate could not be issued before the record exists)."
      echo "Once the record is published, re-run this script with the same options to serve it."
      return 0
    fi
    sleep 10
  done
  OPENPGPKEY_ON=true
  OPENPGPKEY_PENDING=false
  if [[ "$GATEWAY_TLS" == "true" ]]; then
    OPENPGPKEY_HTTPS_LISTENER="https-openpgpkey"
  fi
  if [[ "$GATEWAY_MODE" == "shared" ]]; then
    applySharedGateway
  fi
  installRelease
}

# The records for the hosts and domains of an install without a DNS provider, for the administrator to publish.
function printManualDnsRecords() {
  local domain
  if [[ $SERVER_HOST =~ \.local(host)?$ || $SERVER_HOST = "localhost" ]]; then
    echo "Please update the hosts file to resolve the following:"
    echo -e "\t $SERVER_HOST"
    echo -e "\t $AUTH_HOST"
    return 0
  fi
  # Every name the release answers on has to reach this machine (nginx forwards ports 80 and 443 to the Gateway), and Let's
  # Encrypt checks each name a certificate covers over HTTP before issuing it.
  echo "DNS records these hosts need (A/AAAA records point at this machine's public address):"
  echo -e "\t $SERVER_HOST\t\tA/AAAA to this machine"
  echo -e "\t $AUTH_HOST\t\tA/AAAA to this machine, or CNAME $SERVER_HOST"
  echo -e "\t $AUTODISCOVER_HOST\tA/AAAA to this machine, or CNAME $SERVER_HOST (mail clients' Autodiscover)"
  if [[ "$OPENPGPKEY_ON" = "true" ]]; then
    echo -e "\t $OPENPGPKEY_HOSTNAME\tA/AAAA to this machine, or CNAME $SERVER_HOST (OpenPGP Web Key Directory)"
    echo "$OPENPGPKEY_HOSTNAME is on $SERVER_HOST's certificate: until its record resolves here, that certificate isn't issued."
  else
    echo "$OPENPGPKEY_HOSTNAME (the OpenPGP Web Key Directory host) isn't served. To serve it, add its record (A/AAAA to"
    echo "this machine, or CNAME $SERVER_HOST) first, then re-run with --openpgpkey-host true (or auto, which serves it once"
    echo "the record resolves here): before the record exists the certificate covering it is never issued."
  fi
  echo "DNS records each domain needs (its ownership, DKIM and DMARC values are in the admin console, on the domain's DNS panel):"
  for domain in `seedDomains`; do
    echo -e "\t $domain\t\tMX 10 $SERVER_HOST, and TXT v=spf1 mx ~all"
  done
}

# The final message of an install with a DNS provider (restapi 12.3): what is being published, what stays manual and why, and where to watch it.
function printDnsSummary() {
  local label host domain outside=false existing
  existing=`seedDomains | paste -sd, -`
  label=`dnsProviderLabel "$DNS_PROVIDER"`
  echo "DNS records are published through $label for the zone $DNS_ZONE by the DNS controller ($FULLNAME-dns-controller), which reads the"
  echo "records the server wants and has external-dns apply them; they appear within a few minutes."
  if [[ ${#PUBLIC_ADDRESSES[@]} -eq 0 ]]; then
    echo "No public address is known, so $SERVER_HOST's A/AAAA records are not published: re-run with --public-address <ip> (repeatable), or add them yourself."
  else
    echo -e "\t $SERVER_HOST\t\tA/AAAA ${PUBLIC_ADDRESSES[*]}"
  fi
  if [[ ${#UNPUBLISHED_IPV6[@]} -gt 0 ]]; then
    echo "  Not published: the IPv6 address(es) ${UNPUBLISHED_IPV6[*]} (the mail ports are reachable over IPv4 only here). Re-run with --public-address <ip> to publish one."
  fi
  echo -e "\t $AUTH_HOST\t\tCNAME $SERVER_HOST"
  echo -e "\t $AUTODISCOVER_HOST\tCNAME $SERVER_HOST"
  if [[ "$OPENPGPKEY_ON" == "true" ]]; then
    echo -e "\t $OPENPGPKEY_HOSTNAME\tCNAME $SERVER_HOST (OpenPGP Web Key Directory)"
  elif [[ "$OPENPGPKEY_PENDING" == "true" ]]; then
    echo "$OPENPGPKEY_HOSTNAME (the OpenPGP Web Key Directory host) is published but not served yet: re-run this script with the same options once it resolves."
  fi
  if [[ "$DNS_DOMAINS_ASSIGNED" == "true" ]]; then
    echo "For each domain in the zone: its MX record (to $SERVER_HOST), DKIM key, DMARC policy, ownership TXT, openpgpkey and autodiscover records."
  else
    echo "The domains that existed before this run ($existing) are not on this provider yet, so none of their records is published: the server never changes"
    echo "a domain that exists. Assign each to the provider on the domain's DNS panel in the admin console; its MX, DKIM, DMARC, ownership, openpgpkey and"
    echo "autodiscover records are published then. $OPENPGPKEY_HOSTNAME is served when you re-run this script after that, once its record resolves."
  fi
  echo "Left to you:"
  for host in "$SERVER_HOST" "$AUTH_HOST" "$AUTODISCOVER_HOST"; do
    if ! dnsZoneCovers "$DNS_ZONE" "$host"; then
      echo "  $host is outside the zone $DNS_ZONE: publish it yourself."
      outside=true
    fi
  done
  for domain in `seedDomains`; do
    if ! dnsZoneCovers "$DNS_ZONE" "$domain"; then
      echo "  $domain is outside the zone $DNS_ZONE: publish its records yourself (the admin console lists them)."
      outside=true
    fi
  done
  echo "  SPF (v=spf1 mx ~all) at each domain's root: publish it yourself until you let RapidMX manage the domain's root TXT records in the admin console,"
  echo "  which replaces the TXT values there with the ones you choose to keep."
  if [[ "$DNS_PROVIDER" == "rfc2136" ]]; then
    echo "  RFC 2136 can't manage MX and SRV records: publish them yourself."
  fi
  if [[ "$DNS_TAKEOVER" == "true" && "$DNS_CONFIG_EXISTED" == "true" ]]; then
    echo "--dns-takeover was not applied: it only sets a provider config the server creates, and this one existed. Turn on takeover in the admin console"
    echo "(the provider's settings) to have RapidMX replace the records that already exist at these names; until then they show as conflicts."
  elif [[ "$DNS_TAKEOVER" == "true" ]]; then
    echo "Records that already exist at these names are taken over (--dns-takeover): RapidMX replaces their values."
  else
    echo "Records that already exist at these names are left alone and show as conflicts in the admin console, where you can take them over, or"
    echo "re-run with --dns-takeover."
  fi
  if [[ "$DNS_PROVIDER" == "cloudflare" ]]; then
    echo "If the Cloudflare token is restricted to client IP addresses, it must list every address this cluster goes out from, IPv4 and IPv6."
  fi
  echo "Watch it in the admin console (the domain's DNS panel, Integrations), or with:"
  echo "  kubectl -n $NAMESPACE get dnsendpoints"
  echo "  kubectl -n $NAMESPACE logs deployment/$FULLNAME-dns-controller"
  echo "Run this script again with the same --dns-* flags to upgrade: without them publishing is turned off (the controller is removed; what it"
  echo "published stays). --uninstall removes the records it published unless --keep-dns is given."
}

# The DNSEndpoints of namespace $1 that selector $2 matches, one line each: <name>|<the domain it is for, if any>|<records>|<TXT names>, where records
# are <dnsName>=<type>=<target>,<target>,; per record that is not TXT and the TXT names are <dnsName>; (TXT values can hold anything, and nothing
# here needs them).
function dnsEndpointRows() {
  kubectl -n "$1" get dnsendpoints -l "$2" -o jsonpath='{range .items[*]}{.metadata.name}{"|"}{.metadata.labels.rapidmx\.io/domain}{"|"}{range .spec.endpoints[?(@.recordType!="TXT")]}{.dnsName}{"="}{.recordType}{"="}{range .targets[*]}{@}{","}{end}{";"}{end}{"|"}{range .spec.endpoints[?(@.recordType=="TXT")]}{.dnsName}{";"}{end}{"\n"}{end}' 2>/dev/null
}

# DNS name or answer $1 as compared: lowercase, one space between words, no trailing dot.
function dnsNormalize() {
  local value
  value=`printf '%s' "${1,,}" | tr -s '[:space:]' ' '`
  value=${value# }
  value=${value% }
  printf '%s' "${value%.}"
}

# Succeeds when DNS name $1 still answers record type $2 with one of the targets in $3 (comma-separated): a record that is there but isn't what the
# DNSEndpoint published (a record that was there before, left alone because takeover wasn't on) isn't something external-dns removes.
function dnsServesTarget() {
  local answer target targets=()
  IFS=, read -r -a targets <<< "$3"
  while IFS= read -r answer; do
    if [[ -z "$answer" ]]; then
      continue
    fi
    answer=`dnsNormalize "$answer"`
    for target in "${targets[@]}"; do
      if [[ -n "$target" && "$answer" == "`dnsNormalize "$target"`" ]]; then
        return 0
      fi
    done
  done < <(dnsLookup "$1" "$2")
  return 1
}

# Whether this release publishes DNS records already (its DNS controller is installed), when this run has no --dns-provider: the chart is upgraded with
# publishing off then, since a run sets every value it needs and none is remembered. reportPublishingTurnedOff says so afterwards.
function notePublishingBefore() {
  PUBLISHING_WAS_ON=false
  if [[ -z "$DNS_PROVIDER" ]] && kubectl -n "$NAMESPACE" get deployment "$FULLNAME-dns-controller" >/dev/null 2>&1; then
    PUBLISHING_WAS_ON=true
  fi
}

function reportPublishingTurnedOff() {
  if [[ "$PUBLISHING_WAS_ON" != "true" || -n "$DNS_PROVIDER" ]]; then
    return 0
  fi
  echo "This release was publishing DNS records, but this run had no --dns-provider, so publishing is off now: the DNS controller was removed."
  echo "What it made stays - external-dns's Deployments and Secrets, the DNSEndpoints and the records in DNS (README, 'Turning publishing off')."
  echo "Run this script again with the same --dns-* flags to turn publishing back on."
}

# --uninstall, for what the DNS controller published (restapi 9.5, 12.4), before the release goes: stops the controller so it can't put anything
# back, deletes the release's DNSEndpoints so external-dns removes the records it owns, waits (bounded) until the hosts' and domains' records
# have left DNS, and removes what the controller made that Helm doesn't own (external-dns's Deployments, their credentials Secrets, Jobs, the
# controller's Lease) by label. --keep-dns stops external-dns first instead, so no record is deleted at all. The CRD goes only if this script
# installed it and no DNSEndpoint is left in the cluster. Returns 1, having removed nothing, when a domain's apex TXT set is managed by RapidMX:
# deleting its DNSEndpoint would delete every value in it, and only the admin console (a domain's opt-out) can put the kept values back, since
# this script has no credentials for the server's API.
function uninstallDns() {
  local release=$1 keep=$2 fullname=$1 selector controller crd=false rows="" name domain records txts rec rest dnsName type apex managed="" mxNames=" " txtNames=()
  local pairs=() pair remaining deadline
  if [[ "$release" != *server* ]]; then
    fullname="$release-server"
  fi
  controller="$fullname-dns-controller"
  selector="app.kubernetes.io/managed-by=rapidmx-dns-controller,app.kubernetes.io/instance=$release"
  if ! kubectl get nodes >/dev/null 2>&1; then
    echo "The cluster can't be reached, so what the DNS controller published isn't checked or removed here."
    return 0
  fi
  if kubectl get crd "$DNS_CRD_NAME" >/dev/null 2>&1; then
    crd=true
    rows=`dnsEndpointRows "$release" "$selector"`
  fi
  # One row per DNSEndpoint (dnsEndpointRows): the records that are not TXT, which are what to wait for, and the names of the TXT ones. A domain's apex
  # TXT set is a TXT record at the domain's own name: found by the domain label when the set has one, and else as the TXT name that also has an MX
  # record or a _dmarc. name beside it (the controller leaves the label off a name that isn't a valid label value, longer than 63 characters).
  while IFS='|' read -r name domain records txts; do
    mxNames=" "
    IFS=';' read -r -a txtNames <<< "$txts"
    while IFS= read -r rec; do
      if [[ "$rec" != *=*=* ]]; then
        continue
      fi
      dnsName=${rec%%=*}
      rest=${rec#*=}
      type=${rest%%=*}
      pairs+=("$dnsName=$type=${rest#*=}")
      if [[ "$type" == "MX" ]]; then
        mxNames+="${dnsName,,} "
      fi
    done < <(tr ';' '\n' <<< "$records")
    for apex in "${txtNames[@]}"; do
      if [[ -n "$domain" && "${apex,,}" == "${domain,,}" ]] || [[ "$mxNames" == *" ${apex,,} "* ]] || [[ " ${txtNames[*],,} " == *" _dmarc.${apex,,} "* ]]; then
        managed+=" $apex"
      fi
    done
  done <<< "$rows"
  if [[ -n "$managed" && "$keep" != "true" ]]; then
    echo "RapidMX manages the apex TXT set (the SPF value and the values kept beside it) of:$managed"
    echo "Removing the publishing deletes every value in such a set. Put the values back first: opt each domain out of managing its apex TXT"
    echo "set in the admin console (the domain's DNS panel), which restores them as they were before RapidMX. Then run --uninstall again."
    if ! kubectl -n "$release" get deployment "$controller" >/dev/null 2>&1; then
      echo "The DNS controller ($controller) isn't running, and it is what carries out the restore: turn publishing back on first (run this script"
      echo "again with the same --dns-* flags), opt the domain out, wait for the restore, and then run --uninstall."
    fi
    echo "Or run it with --keep-dns, which leaves every record in DNS as it is."
    return 1
  fi
  if kubectl -n "$release" get deployment "$controller" >/dev/null 2>&1; then
    kubectl -n "$release" scale deployment "$controller" --replicas=0
    kubectl -n "$release" wait --for=delete pod -l app=dns-controller --timeout=2m >/dev/null 2>&1
  fi
  if [[ "$keep" == "true" ]]; then
    kubectl -n "$release" scale deployments -l "$selector,app.kubernetes.io/name=external-dns" --replicas=0
    kubectl -n "$release" wait --for=delete pod -l "$selector,app.kubernetes.io/name=external-dns" --timeout=2m >/dev/null 2>&1
    if [[ "$crd" == "true" ]]; then
      kubectl -n "$release" delete dnsendpoints -l "$selector" --ignore-not-found
    fi
    echo "The DNS records RapidMX published were left as they are (--keep-dns): remove them at your DNS provider if you don't want them."
  elif [[ "$crd" == "true" ]]; then
    kubectl -n "$release" delete dnsendpoints -l "$selector" --ignore-not-found
    if [[ ${#pairs[@]} -gt 0 ]]; then
      echo "Waiting for external-dns to remove the records (up to ${DNS_CLEANUP_WAIT_SECONDS}s)..."
      deadline=$(( SECONDS + DNS_CLEANUP_WAIT_SECONDS ))
      while true; do
        remaining=""
        for pair in `printf '%s\n' "${pairs[@]}" | sort -u`; do
          # <dnsName>=<type>=<targets>: only an answer that is one of the targets the DNSEndpoint published is waited for.
          rest=${pair#*=}
          if dnsServesTarget "${pair%%=*}" "${rest%%=*}" "${rest#*=}"; then
            remaining+=" ${pair%%=*}"
          fi
        done
        if [[ -z "$remaining" ]]; then
          echo "The DNS records RapidMX published have been removed."
          break
        fi
        if (( SECONDS >= deadline )); then
          echo "These names still answer with what RapidMX published:$remaining. external-dns is removed next, so remove them at your DNS provider by hand if they"
          echo "should go (they may also be cached still)."
          break
        fi
        sleep 15
      done
    fi
  fi
  kubectl -n "$release" delete deployments,jobs,secrets -l "$selector" --ignore-not-found
  kubectl -n "$release" delete lease "$controller" --ignore-not-found
  kubectl -n "$release" delete secret "$fullname-dns-bootstrap" --ignore-not-found
  if [[ "$crd" == "true" && "`installedBy dns_crd`" == "true" ]]; then
    if [[ -z "`kubectl get dnsendpoints -A -o name 2>/dev/null`" ]]; then
      kubectl delete crd "$DNS_CRD_NAME" --ignore-not-found
      echo "Removed the DNSEndpoint CRD this script installed."
    else
      echo "The DNSEndpoint CRD is kept: other DNSEndpoints still use it."
    fi
  fi
  return 0
}

function uninstall() {
  # This removes the mail itself (blobs), the DKIM private keys and the encryption CA's key, and none of it can be recovered.
  if [[ "$CONFIRM_UNINSTALL" != "true" ]]; then
    echo "--uninstall permanently deletes this installation's data: the mailboxes' messages, the DKIM keys and the encryption CA's key"
    echo "(with k3s, the whole cluster). So does the configuration keyring the credentials saved in the admin console are encrypted with, when it is in the"
    echo "cluster being removed (k3s) or in an OpenBao this script installed; otherwise it stays. The DNS records RapidMX published are removed from DNS too,"
    echo "unless you add --keep-dns. Run it again with --yes to confirm, after backing up what you need."
    exit 1
  fi
  if [[ -z "$KUBECONFIG" && -f "$USER_KUBECONFIG" ]]; then
    export KUBECONFIG="$USER_KUBECONFIG"
  fi
  if ! sudo test -f "$STATE_FILE"; then
    echo "$STATE_FILE doesn't exist, so there is no record of what this script installed (or an earlier version of it"
    echo "did the install). Only this script's nginx configuration is removed; remove k3s, helm and nginx manually if"
    echo "this script installed them."
  fi
  local release
  release=`installedBy release`
  if [[ -n "$release" ]]; then
    # What the DNS controller published goes first, while the controller and external-dns can still be asked, and before k3s takes them with the cluster:
    # without --keep-dns the records are removed, and a domain's apex TXT set that RapidMX manages stops the uninstall, with nothing removed.
    if ! uninstallDns "$release" "$KEEP_DNS"; then
      exit 1
    fi
  fi
  if [[ "`installedBy k3s`" = "true" ]]; then
    # Removes the whole cluster, with everything this script installed into it.
    echo "Removing k3s..."
    sudo /usr/local/bin/k3s-uninstall.sh
  else
    if [[ -n "$release" ]]; then
      reportConfigKeyring "$release"
      echo "Removing the RapidMX server release (including its data volumes)..."
      helm uninstall "$release" -n "$release"
      # The chart keeps its DKIM, blob and PKI volumes when uninstalled (mail.storage.keepOnUninstall); --yes asked for them to go.
      kubectl -n "$release" delete pvc --all --ignore-not-found
      # The copy of OpenBao's CA this script made (not part of the release).
      kubectl -n "$release" delete configmap "$OPENBAO_CA_CONFIGMAP" --ignore-not-found
      kubectl -n "$release" delete clienttrafficpolicy --all --ignore-not-found
    fi
    if [[ "`installedBy cluster_issuer`" = "true" ]]; then
      echo "Removing the letsencrypt-prod ClusterIssuer..."
      kubectl delete clusterissuer letsencrypt-prod --ignore-not-found
    fi
    local openbaoNamespace
    openbaoNamespace=`installedBy openbao`
    if [[ -n "$openbaoNamespace" ]]; then
      echo "Removing OpenBao, with the unseal key and everything the vault held, the configuration keyring included..."
      kubectl -n "$openbaoNamespace" delete deployment openbao-unsealer --ignore-not-found
      helm uninstall openbao -n "$openbaoNamespace"
      kubectl delete namespace "$openbaoNamespace" --ignore-not-found
    fi
    if [[ "`installedBy external_secrets`" = "true" ]]; then
      echo "Removing external-secrets..."
      helm uninstall external-secrets -n external-secrets
    fi
    if [[ "`installedBy cert_manager`" = "true" ]]; then
      echo "Removing cert-manager..."
      helm uninstall cert-manager -n cert-manager
    fi
  fi

  local nginxInstalledBy
  nginxInstalledBy=`installedBy nginx`
  if [[ -f "$NGINX_CONF" ]]; then
    if sudo grep -qxF "$NGINX_BEGIN" "$NGINX_CONF"; then
      echo "Removing this script's block from $NGINX_CONF..."
      sudo sed -i "/^$NGINX_BEGIN\$/,/^$NGINX_END\$/d" "$NGINX_CONF"
    fi
    if sudo grep -qF "$NGINX_DISABLED_PREFIX" "$NGINX_CONF"; then
      echo "Restoring the http server block(s) this script commented out..."
      sudo sed -i "s/^$NGINX_DISABLED_PREFIX//" "$NGINX_CONF"
    fi
  fi
  if [[ "`installedBy nginx_default_site`" = "moved" ]] && sudo test -e "$STATE_DIR/sites-enabled-default"; then
    sudo mv "$STATE_DIR/sites-enabled-default" /etc/nginx/sites-enabled/default
  fi
  if [[ "$nginxInstalledBy" = "dnf" ]]; then
    echo "Removing nginx..."
    sudo dnf remove nginx nginx-mod-stream -y
  elif [[ "$nginxInstalledBy" = "apt" ]]; then
    echo "Removing nginx..."
    sudo apt-get remove nginx libnginx-mod-stream -y
  elif command -v nginx >/dev/null 2>&1 && systemctl is-active --quiet nginx; then
    sudo systemctl restart nginx
  fi
  if [[ "`installedBy selinux_nginx_relay`" = "true" ]]; then
    sudo setsebool -P httpd_can_network_relay 0
  fi
  if sudo test -f "$FIREWALL_RULES"; then
    echo "Removing the firewall rules this script added..."
    local tool args
    while read -r tool args; do
      case "$tool" in
        firewalld)
          # shellcheck disable=SC2086 # "<zone> <kind> <value>", none of which contain spaces.
          set -- $args
          sudo firewall-cmd --permanent --zone="$1" "--remove-$2=$3" >/dev/null
          sudo firewall-cmd --reload >/dev/null
          ;;
        ufw)
          # shellcheck disable=SC2086 # The rule's words, e.g. "allow from 10.42.0.0/16 to any".
          sudo ufw delete $args >/dev/null
          ;;
      esac
    done < <(sudo cat "$FIREWALL_RULES")
    sudo rm -f "$FIREWALL_RULES"
  fi

  case "`installedBy helm`" in
    snap)
      echo "Removing helm..."
      sudo snap remove helm
      ;;
    script)
      echo "Removing helm..."
      sudo rm -f /usr/local/bin/helm
      ;;
  esac

  sudo rm -f "$STATE_FILE"
  echo "Uninstall complete! $USER_KUBECONFIG was left in place; delete it if it only held this cluster."
}

GETOPT=$(getopt -o h --long domain:,mail-host:,auth-host:,mail-domains:,version:,tls:,gateway:,openbao:,openpgpkey-host:,dns-provider:,dns-zone:,dns-credentials-file:,dns-takeover,public-address:,keep-dns,email:,uninstall,yes,install-cert-manager,skip-k3s,help -- "$@")
if [ $? -ne 0 ]; then
  exit 1
fi
eval set -- "$GETOPT"
while true
do
    case "$1" in
        --domain) DOMAIN=$2; shift 2;;
        --mail-host) MAIL_HOST=$2; shift 2;;
        --auth-host) AUTH_HOST=$2; shift 2;;
        --mail-domains) MAIL_DOMAINS=$2; shift 2;;
        --version) VERSION=$2; shift 2;;
        --tls) TLS=$2; shift 2;;
        --gateway) GATEWAY_MODE=$2; shift 2;;
        --openbao) OPENBAO=$2; shift 2;;
        --openpgpkey-host) OPENPGPKEY_HOST=$2; shift 2;;
        --dns-provider) DNS_PROVIDER=$2; shift 2;;
        --dns-zone) DNS_ZONE=$2; shift 2;;
        --dns-credentials-file) DNS_CREDENTIALS_FILE=$2; shift 2;;
        --dns-takeover) DNS_TAKEOVER=true; shift;;
        --public-address) addPublicAddress "$2"; shift 2;;
        --keep-dns) KEEP_DNS=true; shift;;
        --email) ACME_EMAIL=$2; shift 2;;
        --skip-k3s) SKIP_K3S=true; shift;;
        --uninstall) UNINSTALL=true; shift;;
        --yes) CONFIRM_UNINSTALL=true; shift;;
        --install-cert-manager) TLS=true; shift;;
        -h | --help)
          echo "This scripts sets up a complete single-node k3s (Kubernetes) cluster. No arguments will do an install"
          echo "During install this will install the following:"
          echo -e "\tk3s - Kubernetes distribution (includes kubectl)"
          echo -e "\thelm - Helm to handle install/update software in k3s"
          echo -e "\tenvoy-gateway - Gateway API implementation routing traffic to the services"
          echo -e "\tnginx - Nginx to forward ports 80 and 443 to envoy-gateway"
          echo -e "\tcert-manager - Let's Encrypt certificates (with --tls true)"
          echo -e "\topenbao - the vault holding the release's secrets and its mail encryption CA (with --openbao true)"
          echo -e "\texternal-secrets - delivers the chart's OpenBao-held secrets into Kubernetes Secrets"
          echo -e "\tRapidMX server - with auth-server, Postfix and postfix-bridge (SMTP on port 25)"

          echo "Usage:"
          echo -e "\t--domain <domain>\t\tThe mail domain, e.g. example.com: the server is at mail.<domain>,"
          echo -e "\t\t\t\tthe auth-server at auth.<domain>, and mail is addressed @<domain>"
          echo -e "\t--mail-host <name>\t\tThe server's own host name or label (default mail, i.e. mail.<domain>)"
          echo -e "\t--auth-host <name>\t\tThe auth-server's host name or label (default auth, i.e. auth.<domain>)"
          echo -e "\t--mail-domains <domains>\tComma-separated domains Postfix knows when it starts (default <domain>); domains added"
          echo -e "\t\t\t\tin the admin console later need no restart or re-run"
          echo -e "\t--version <version>\t\tThe version of mail-server to deploy"
          echo -e "\t--tls <true|false>\t\tInstalls cert manager and enables TLS ingress support (uses Let's Encrypt)"
          echo -e "\t--gateway <shared|chart>\tshared (default): one Gateway made by this script that the release's routes"
          echo -e "\t\t\t\tattach to; chart: the chart makes a Gateway for each of its hosts"
          echo -e "\t--openbao <true|false>\t\tInstalls OpenBao and keeps the release's secrets and encryption CA in it"
          echo -e "\t\t\t\t(default true; false keeps them in Kubernetes Secrets)"
          echo -e "\t--openpgpkey-host <true|false|auto>\tAlso serves openpgpkey.<domain>, the OpenPGP Web Key Directory host. auto (the"
          echo -e "\t\t\t\tdefault) serves it once its DNS record resolves to this server (with --dns-provider the provider"
          echo -e "\t\t\t\tpublishes it and the release is upgraded when it does). Its record must exist before the server's"
          echo -e "\t\t\t\tcertificate, which covers it, can be issued"
          echo -e "\t--dns-provider <type>\t\tPublishes the DNS records of this install through external-dns: cloudflare, route53, rfc2136,"
          echo -e "\t\t\t\tgoogle or azure. Installs the DNSEndpoint CRD and the DNS controller, and has the server create the"
          echo -e "\t\t\t\tprovider config from the credentials below. Needs --domain inside the DNS zone"
          echo -e "\t--dns-zone <zone>\t\tThe DNS zone --dns-provider publishes into (default: --domain; for Cloudflare, the zone it has"
          echo -e "\t\t\t\tfor --domain or a parent of it). Name it when --domain is below the zone's apex"
          echo -e "\t--dns-credentials-file <path>\tA file of NAME=value lines with the provider's credentials (and options), read once and"
          echo -e "\t\t\t\tnever run. What it doesn't set is read from the environment. Never a value on the command line"
          echo -e "\t--dns-takeover\t\t\tLets the provider replace records that already exist at the names RapidMX publishes"
          echo -e "\t--public-address <ip>\t\tThe public IPv4/IPv6 address of this machine, which the mail host's A/AAAA records point at"
          echo -e "\t\t\t\t(repeatable). Detected when not given: the node's global addresses, else the one seen from outside"
          echo -e "\t--keep-dns\t\t\tWith --uninstall: leaves the DNS records RapidMX published in DNS"
          echo -e "\t--email <email>\t\tThe Let's Encrypt account email (default admin@<domain>)"
          echo -e "\t--skip-k3s\t\tSkips installation of k3s"
          echo -e "\t--uninstall\t\tUninstalls what this script installed (recorded in $STATE_FILE), including the mail data"
          echo -e "\t--yes\t\t\tConfirms --uninstall; without it nothing is removed"
          echo "Environment:"
          echo -e "\tCHART\t\t\tThe chart to install (default $CHART), e.g. ./helm for a local checkout"
          echo -e "\tEXTERNAL_SECRETS_VERSION\tThe external-secrets release to install (default $EXTERNAL_SECRETS_VERSION)"
          echo -e "\tOPENBAO_VERSION\t\tThe openbao chart to install (default $OPENBAO_VERSION)"
          echo -e "\tOPENBAO_ADDRESS\t\tAn OpenBao this cluster already runs (https), used instead of installing one"
          echo -e "\tOPENBAO_CA_FILE\t\tThe CA (PEM) of that OpenBao's listener certificate, when the system doesn't trust it"
          echo -e "\tOPENPGPKEY_HOST\t\tThe default of --openpgpkey-host (default auto)"
          echo -e "\tDNS_PROVIDER\t\tThe default of --dns-provider"
          echo -e "\tCF_API_TOKEN\t\tCloudflare: an API token with Zone:Zone:Read and Zone:DNS:Edit on the zone (if it is restricted by"
          echo -e "\t\t\t\tclient IP address, list every address the cluster goes out from, IPv4 and IPv6)"
          echo -e "\tAWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION\tRoute 53 (the keys may be left out to use the role of external-dns's"
          echo -e "\t\t\t\tservice account), EXTERNAL_DNS_AWS_ZONE_TYPE and EXTERNAL_DNS_AWS_ASSUME_ROLE optionally"
          echo -e "\tEXTERNAL_DNS_RFC2136_HOST, _PORT, _ZONE, _TSIG_KEYNAME, _TSIG_SECRET, _TSIG_SECRET_ALG, _INSECURE\trfc2136"
          echo -e "\tGOOGLE_APPLICATION_CREDENTIALS, EXTERNAL_DNS_GOOGLE_PROJECT\tGoogle Cloud DNS (the key file's path, the project)"
          echo -e "\tAZURE_CLIENT_ID, AZURE_CLIENT_SECRET, AZURE_TENANT_ID, AZURE_SUBSCRIPTION_ID, AZURE_RESOURCE_GROUP\tAzure DNS"
          echo -e "\t\t\t\t(sudo passes none of these on unless you ask: sudo -E, or put them in --dns-credentials-file)"
          echo -e "\tDNS_CONTROLLER_TAG\tThe dns-controller release to deploy (dns.controller.image.tag); DNS_CONTROLLER_DIGEST pins by digest instead"
          exit 1
          ;;
        --) shift; break;;
        *) break;;
    esac
done
if [[ "$TLS" != "true" && "$TLS" != "false" ]]; then
  echo "--tls must be true or false."
  exit 1
fi
if [[ "$OPENBAO" != "true" && "$OPENBAO" != "false" ]]; then
  echo "--openbao must be true or false."
  exit 1
fi
if [[ "$OPENPGPKEY_HOST" != "true" && "$OPENPGPKEY_HOST" != "false" && "$OPENPGPKEY_HOST" != "auto" ]]; then
  echo "--openpgpkey-host must be true, false or auto."
  exit 1
fi
if [[ -n "$DNS_PROVIDER" ]]; then
  case "$DNS_PROVIDER" in
    cloudflare|route53|rfc2136|google|azure) ;;
    *)
      echo "--dns-provider must be one of: cloudflare, route53, rfc2136, google, azure."
      exit 1
      ;;
  esac
  if [[ -n "$DNS_CREDENTIALS_FILE" && ( ! -f "$DNS_CREDENTIALS_FILE" || ! -r "$DNS_CREDENTIALS_FILE" ) ]]; then
    echo "--dns-credentials-file ($DNS_CREDENTIALS_FILE) isn't a readable file."
    exit 1
  fi
else
  if [[ "$DNS_TAKEOVER" = "true" ]]; then
    echo "--dns-takeover needs --dns-provider."
    exit 1
  fi
  if [[ -n "$DNS_ZONE" ]]; then
    echo "--dns-zone needs --dns-provider."
    exit 1
  fi
  if [[ -n "$DNS_CREDENTIALS_FILE" ]]; then
    echo "--dns-credentials-file needs --dns-provider."
    exit 1
  fi
  if [[ ${#PUBLIC_ADDRESSES[@]} -gt 0 ]]; then
    echo "--public-address needs --dns-provider."
    exit 1
  fi
fi
if [[ "$KEEP_DNS" = "true" && "$UNINSTALL" != "true" ]]; then
  echo "--keep-dns only applies to --uninstall."
  exit 1
fi
if [[ "$GATEWAY_MODE" != "shared" && "$GATEWAY_MODE" != "chart" ]]; then
  echo "--gateway must be shared or chart."
  exit 1
fi
# With OPENBAO_ADDRESS the vault is yours: this script neither installs nor prepares one, it only points the chart at it.
OPENBAO_INSTALL=false
if [[ "$OPENBAO" = "true" && -z "$OPENBAO_ADDRESS" ]]; then
  OPENBAO_INSTALL=true
  OPENBAO_ADDRESS="https://openbao.$OPENBAO_NAMESPACE.svc:8200"
elif [[ "$OPENBAO" = "true" ]] && ! openbaoAddressAllowed "$OPENBAO_ADDRESS"; then
  echo "OPENBAO_ADDRESS must be an https:// address (plain http:// only to this host): the release's secrets and the tokens"
  echo "that read them would cross the network unencrypted."
  exit 1
fi
if [[ -n "$OPENBAO_CA_FILE" && ! -s "$OPENBAO_CA_FILE" ]]; then
  echo "OPENBAO_CA_FILE ($OPENBAO_CA_FILE) isn't a readable, non-empty file."
  exit 1
fi
ACME_EMAIL=${ACME_EMAIL:-admin@$DOMAIN}
MAIL_DOMAINS=${MAIL_DOMAINS:-$DOMAIN}
SERVER_HOST=`hostFor "$DOMAIN" "$MAIL_HOST"`
AUTH_HOST=`hostFor "$DOMAIN" "$AUTH_HOST"`
# Mail clients' Autodiscover probe looks for autodiscover.<domain> whatever MAIL_HOST is; openpgpkey.<domain> is the OpenPGP Web Key Directory host.
AUTODISCOVER_HOST="autodiscover.$DOMAIN"
OPENPGPKEY_HOSTNAME="openpgpkey.$DOMAIN"
# The chart's resource prefix (its "rrst.fullname"): the release name, suffixed with the chart name "server" unless the
# release name already contains it. The vault's paths and token Secrets are named after it.
FULLNAME=$NAMESPACE
if [[ "$NAMESPACE" != *server* ]]; then
  FULLNAME="$NAMESPACE-server"
fi
# Where this release's secrets live in the vault (the chart's global.openbao.secretsPath).
OPENBAO_SECRETS_PATH="$FULLNAME/secrets"
# The configuration keyring (restapi's specs/dns_publishing_and_integrations.md, 5.3): the key the credentials, API keys and tokens saved in the admin
# console are encrypted with. In the vault it is its own KV secret (the chart's configEncryption.openbao.path), which the chart's ExternalSecret syncs
# into the Secret $KEYRING_SECRET the server pods mount; without OpenBao the chart renders that Secret itself, once, and Helm keeps it.
OPENBAO_KEYRING_PATH="$FULLNAME/config-keyring"
KEYRING_SECRET="$FULLNAME-config-keyring"
# The Secrets holding the tokens earlier versions of this script made, one for External Secrets and one for the server's PKI
# client: a vault this script installs has its clients log in with Kubernetes auth instead, and migrateOpenbaoTokens revokes
# them. A vault of your own (OPENBAO_ADDRESS) still gives External Secrets its token in the first.
OPENBAO_ESO_SECRET="$FULLNAME-openbao-eso"
OPENBAO_PKI_SECRET="$FULLNAME-openbao-pki"
# The copy of the CA OpenBao's listener certificate comes from, in the release's namespace (the chart's global.openbao.caConfigMap).
OPENBAO_CA_CONFIGMAP="$FULLNAME-openbao-ca"
# OpenBao's kubernetes auth roles, one per client, each bound to one ServiceAccount of this namespace: the server (the
# chart's ServiceAccount, named like the release) and External Secrets (a ServiceAccount the chart creates for it alone).
OPENBAO_SERVER_ROLE="$FULLNAME-server"
OPENBAO_ESO_ROLE="$FULLNAME-eso"
OPENBAO_ESO_SERVICE_ACCOUNT="$FULLNAME-openbao-eso"
if [[ "$TLS" = "false" ]]; then
  # No cert-manager step.
  total_steps=$(( total_steps - 1 ))
fi
if [[ "$OPENBAO_INSTALL" = "true" ]]; then
  # One more step for the vault itself; external-secrets is already counted.
  total_steps=$(( total_steps + 1 ))
elif [[ "$OPENBAO" = "false" ]]; then
  # And none for external-secrets either: without a vault the chart renders its own Kubernetes Secrets.
  total_steps=$(( total_steps - 1 ))
fi

if [[ "$UNINSTALL" = "true" ]]; then
  uninstall
  exit 0
fi

# Everything --dns-provider needs that can be checked before anything is installed (the zone, the credentials, Cloudflare's zone id, the public
# addresses), then how openpgpkey.<domain> is installed: now, in a second step once its record is published, or not at all.
prepareDns
decideOpenpgpkeyHost

# Catch Ctrl-C, kill, termination, normal exit
trap cleanup EXIT INT TERM

# Start background progress bar
#progress_loop --bg &
#progress_pid=$!

# Detect the OS distribution and set the correct package manager
run_step "Updating system packages"
if [[ -e /etc/redhat-release ]]; then
  echo "Detected RHEL based operating system."
  sudo dnf check-update
elif grep -qi Microsoft /proc/version; then
  echo "Bash is running on WSL"
  sudo apt -qq update
  IS_WSL=true
# Check if /etc/debian_version exists
elif [[ -e /etc/debian_version ]]; then
  echo "Detected Debian/Ubuntu based operating system."
  sudo apt-get update
else
  echo "Unable to determine Linux distribution."
  exit 1
fi

# For WSL check for another installation
run_step "Installing kubernetes (k3s)"
if [[ "$IS_WSL" = "true" ]]; then
  if [[ `kubectl get nodes 2>/dev/null | grep ' Ready ' | wc -l` -eq 1 ]]; then
    SKIP_K3S=true
    echo "Skipping installation of k3s"
  fi
fi

if [[ "$SKIP_K3S" = "false" ]]; then
  if [[ `ps -aef|grep "docker serve"|grep -v grep|wc -l` -ne 0 ]]; then
    echo "Docker appears to be running and will cause issues with k3s"
    ps -aef|grep "docker serve"|grep -v grep
    exit 1
  fi
  if [[ -n "`activeFirewall`" ]]; then
    # k3s' pod (10.42.0.0/16) and service (10.43.0.0/16) networks must be allowed, or pods can't reach each other or the
    # API server (https://docs.k3s.io/installation/requirements#operating-system-specific-requirements).
    echo "Allowing the k3s pod and service networks in `activeFirewall`..."
    firewallTrustSource 10.42.0.0/16
    firewallTrustSource 10.43.0.0/16
  fi
  if [[ -x /usr/local/bin/k3s ]]; then
    echo "k3s is already installed."
    # Earlier versions of this script installed k3s with a world-readable kubeconfig (K3S_KUBECONFIG_MODE=644).
    if sudo test -f /etc/systemd/system/k3s.service.env && sudo grep -q '^K3S_KUBECONFIG_MODE=' /etc/systemd/system/k3s.service.env; then
      sudo sed -i '/^K3S_KUBECONFIG_MODE=/d' /etc/systemd/system/k3s.service.env
    fi
    sudo chmod 600 "$K3S_KUBECONFIG"
  else
    # Install k3s. Its kubeconfig (cluster-admin) stays root-only; the user gets a private copy below.
    echo "Installing k3s..."
    curl -sfL https://get.k3s.io | INSTALL_K3S_VERSION="$K3S_VERSION" INSTALL_K3S_EXEC="$K3S_OPTIONS" sh -
    if [ $? -ne 0 ]; then
      echo "There was a problem installing k3s."
      exit 1
    fi
    recordInstalled k3s
  fi
  if [[ -z "$KUBECONFIG" || "$KUBECONFIG" = "$K3S_KUBECONFIG" ]]; then
    installKubeconfig
    export KUBECONFIG="$USER_KUBECONFIG"
  fi

  echo "Checking k3s has started..."
  result=`kubectl get nodes 2>/dev/null | grep ' Ready ' | wc -l`
  startTime=`date +%s`
  while [[ $result -eq 0 && $(( `date +%s` - startTime )) -lt 1800 ]]; do
    sleep 2
    echo "Waiting for k3s nodes to be ready..."
    result=`kubectl get nodes 2>/dev/null | grep ' Ready ' | wc -l`
  done
  if [ $result -eq 0 ]; then
    echo "There was a problem installing k3s..."
    exit 1
  else
    echo "k3s is running!"
  fi

  waitForDeployments kube-system kube-system
else
  # Under sudo, HOME is root's, so kubectl wouldn't find the installing user's kubeconfig by itself.
  if [[ -z "$KUBECONFIG" && -f "$USER_KUBECONFIG" ]]; then
    export KUBECONFIG="$USER_KUBECONFIG"
  fi
  if ! command -v kubectl >/dev/null 2>&1; then
    echo "kubectl isn't installed. Install it (and a kubeconfig for the cluster), or run without --skip-k3s."
    exit 1
  fi
  if ! kubectl get nodes >/dev/null 2>&1; then
    echo "kubectl can't reach a cluster. Set KUBECONFIG, or run without --skip-k3s."
    exit 1
  fi
fi

# Install Helm
run_step "Installing helm"
if command -v helm >/dev/null 2>&1; then
  echo "helm is already installed."
else
  if command -v snap >/dev/null 2>&1; then
    sudo snap install --classic helm
    HELM_INSTALLED_BY=snap
  else
    curl -fsSL "https://raw.githubusercontent.com/helm/helm/$HELM_SCRIPT_VERSION/scripts/get-helm-3" | sudo bash
    HELM_INSTALLED_BY=script
  fi
  if ! command -v helm >/dev/null 2>&1; then
    echo "There was a problem installing helm."
    exit 1
  fi
  recordInstalled helm "$HELM_INSTALLED_BY"
fi

# Install cert-manager
run_step "Installing cert-manager"

if ! helm status cert-manager -n cert-manager >/dev/null 2>&1; then
  CERT_MANAGER_NEW=true
fi
helm upgrade --install cert-manager oci://quay.io/jetstack/charts/cert-manager --version "$CERT_MANAGER_VERSION" --namespace cert-manager --create-namespace \
      --set config.apiVersion="controller.config.cert-manager.io/v1alpha1" \
      --set config.kind="ControllerConfiguration" \
      --set config.enableGatewayAPI=true \
      --set crds.enabled=true
waitForDeployments cert-manager cert-manager
if [[ "$CERT_MANAGER_NEW" = "true" ]]; then
  recordInstalled cert_manager
fi

# Install envoy gateway
run_step "Installing envoy-gateway"
if helm status eg -n "$ENVOY_NAMESPACE" >/dev/null 2>&1; then
  # Not upgraded here: helm doesn't upgrade CRDs, see https://gateway.envoyproxy.io/docs/install/install-helm/.
  echo "envoy-gateway is already installed."
elif helm install eg oci://docker.io/envoyproxy/gateway-helm --version "$ENVOY_GATEWAY_VERSION" \
    -n "$ENVOY_NAMESPACE" --create-namespace; then
  recordInstalled envoy_gateway
else
  echo "There was a problem installing envoy-gateway..."
  exit 1
fi
echo "Checking envoy-gateway has started..."
if ! kubectl wait --timeout=5m -n "$ENVOY_NAMESPACE" deployment/envoy-gateway --for=condition=Available; then
  echo "There was a problem installing envoy-gateway..."
  exit 1
fi
echo "envoy-gateway is running!"

# The Gateway's Envoy Service is a ClusterIP: only this host's nginx (below) forwards to it, using the PROXY protocol so
# Envoy puts each client's real address in X-Forwarded-For (the server's rate limits and audit log use it). A NodePort
# would expose Envoy on every interface, where anyone could send a PROXY header claiming any address.
#
# GATEWAY_MODE says whose Gateway the release's routes attach to. "shared": one Gateway ($GATEWAY_NAME in
# $GATEWAY_NAMESPACE), created below with a listener per host. "chart": the chart creates a Gateway for each host (mail
# and auth) in $NAMESPACE. nginx forwards to a single Service either way, so the class those Gateways use merges them into
# one Envoy deployment (mergeGateways) instead of giving each its own Service.
GATEWAY_CLASS=envoy
ENVOY_PROXY=bare-metal-proxy
MERGE_GATEWAYS=false
ENVOY_SELECTOR="gateway.envoyproxy.io/owning-gateway-name=$GATEWAY_NAME,gateway.envoyproxy.io/owning-gateway-namespace=$GATEWAY_NAMESPACE"
if [[ "$GATEWAY_MODE" = "chart" ]]; then
  GATEWAY_CLASS=envoy-merged
  ENVOY_PROXY=bare-metal-merged-proxy
  MERGE_GATEWAYS=true
  ENVOY_SELECTOR="gateway.envoyproxy.io/owning-gatewayclass=$GATEWAY_CLASS"
fi
if ! kubectl get gatewayclass "$GATEWAY_CLASS" >/dev/null 2>&1; then
  ENVOY_GATEWAY_CLASS_NEW=true
fi
if ! kubectl apply -f - << EOF
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: EnvoyProxy
metadata:
  name: $ENVOY_PROXY
  namespace: $ENVOY_NAMESPACE
spec:
  mergeGateways: $MERGE_GATEWAYS
  provider:
    type: Kubernetes
    kubernetes:
      envoyService:
        type: ClusterIP
      # The kubelet probes envoy and its shutdown-manager with a 1 s timeout and restarts the pod after three misses. On a
      # single node that stalls now and then (the runtime is slow to answer for a few seconds), the pod was killed 40 or so
      # times a day, and every restart reset every connection: about 40% of requests failed. Five seconds, six misses.
      envoyDeployment:
        patch:
          type: StrategicMerge
          value:
            spec:
              template:
                spec:
                  containers:
                    - name: envoy
                      livenessProbe:
                        timeoutSeconds: 5
                        failureThreshold: 6
                      readinessProbe:
                        timeoutSeconds: 5
                    - name: shutdown-manager
                      livenessProbe:
                        timeoutSeconds: 5
                        failureThreshold: 6
                      readinessProbe:
                        timeoutSeconds: 5
---
apiVersion: gateway.networking.k8s.io/v1
kind: GatewayClass
metadata:
  name: $GATEWAY_CLASS
spec:
  controllerName: gateway.envoyproxy.io/gatewayclass-controller
  parametersRef:
    group: gateway.envoyproxy.io
    kind: EnvoyProxy
    name: $ENVOY_PROXY
    namespace: $ENVOY_NAMESPACE
EOF
then
  echo "There was a problem configuring the $GATEWAY_CLASS GatewayClass..."
  exit 1
fi
if [[ "$ENVOY_GATEWAY_CLASS_NEW" = "true" ]]; then
  recordInstalled envoy_gateway_class
fi

# TLS is set up only when it's on and the host can get a certificate from Let's Encrypt (not localhost or *.local): the
# chart then has cert-manager issue "<host>-tls-cert" Secrets in $NAMESPACE for $SERVER_HOST and $AUTH_HOST, and the
# Gateway terminates TLS with them. The chart's own Certificate for $SERVER_HOST also covers $AUTODISCOVER_HOST (mail
# clients' Autodiscover probe looks for it regardless of $MAIL_HOST) on the very same Secret, so it needs no Certificate
# of its own - just another listener pointed at $SERVER_HOST's. When it is served ($OPENPGPKEY_ON), so does $OPENPGPKEY_HOSTNAME.
GATEWAY_TLS=false
HTTPS_LISTENER=""
AUTH_HTTPS_LISTENER=""
AUTODISCOVER_HTTPS_LISTENER=""
OPENPGPKEY_HTTPS_LISTENER=""
if [[ "$TLS" = "true" && "$SERVER_HOST" != "localhost" && ! "$SERVER_HOST" =~ \.(local|localhost)$ ]]; then
  GATEWAY_TLS=true
  HTTPS_LISTENER="https"
  AUTODISCOVER_HTTPS_LISTENER="https-autodiscover"
  if [[ "$OPENPGPKEY_ON" = "true" ]]; then
    OPENPGPKEY_HTTPS_LISTENER="https-openpgpkey"
  fi
  # The auth-server subchart only issues a certificate for a host that isn't localhost, *.local or *.localhost.
  if [[ "$AUTH_HOST" != "localhost" && ! "$AUTH_HOST" =~ \.(local|localhost)$ ]]; then
    AUTH_HTTPS_LISTENER="https-auth"
  fi
fi

# Creates (or updates) the shared Gateway with a listener per host that is served. Run again, with the openpgpkey host on, by the second
# step of its install (enableOpenpgpkeyHost).
function applySharedGateway() {
  # An HTTPS listener can only serve a host with a certificate, so it's added only when there is one: "https" for
  # $SERVER_HOST and "https-auth" for $AUTH_HOST. The Gateway is in another namespace than those Secrets, so the chart
  # renders the ReferenceGrant that lets it read them.
  if ! kubectl -n "$GATEWAY_NAMESPACE" get gateway "$GATEWAY_NAME" >/dev/null 2>&1; then
    SHARED_GATEWAY_NEW=true
  fi
  {
  cat << EOF
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: $GATEWAY_NAME
  namespace: $GATEWAY_NAMESPACE
spec:
  gatewayClassName: $GATEWAY_CLASS
  listeners:
  - allowedRoutes:
      namespaces:
        from: All
    name: http
    port: 80
    protocol: HTTP
EOF
  # The Web Key Directory host gets listeners named as on a Gateway the chart makes itself (http-openpgpkey, https-openpgpkey).
  # Its route attaches here by host name, so the catch-all "http" would serve it too; the named one keeps the two modes alike.
  if [[ "$OPENPGPKEY_ON" = "true" ]]; then
  cat << EOF
  - allowedRoutes:
      namespaces:
        from: All
    name: http-openpgpkey
    hostname: "$OPENPGPKEY_HOSTNAME"
    port: 80
    protocol: HTTP
EOF
  fi
  # name:hostname:certHost - certHost names the Secret ("<certHost>-tls-cert") the listener's certificateRefs read,
  # which is the listener's own host except for Autodiscover and the Web Key Directory, which read $SERVER_HOST's (see
  # AUTODISCOVER_HOST above).
  for listener in "$HTTPS_LISTENER:$SERVER_HOST:$SERVER_HOST" "$AUTH_HTTPS_LISTENER:$AUTH_HOST:$AUTH_HOST" \
      "$AUTODISCOVER_HTTPS_LISTENER:$AUTODISCOVER_HOST:$SERVER_HOST" \
      "$OPENPGPKEY_HTTPS_LISTENER:$OPENPGPKEY_HOSTNAME:$SERVER_HOST"; do
    IFS=: read -r name hostname certHost <<< "$listener"
    if [[ -n "$name" ]]; then
  cat << EOF
  - allowedRoutes:
      namespaces:
        from: All
    name: $name
    hostname: "$hostname"
    port: 443
    protocol: HTTPS
    tls:
      mode: Terminate
      certificateRefs:
      - kind: Secret
        name: $certHost-tls-cert
        namespace: $NAMESPACE
EOF
    fi
  done
  cat << EOF
---
# Every connection to the Gateway comes from nginx, which sends the PROXY protocol header; others are refused.
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: ClientTrafficPolicy
metadata:
  name: $GATEWAY_NAME-proxy-protocol
  namespace: $GATEWAY_NAMESPACE
spec:
  targetRefs:
  - group: gateway.networking.k8s.io
    kind: Gateway
    name: $GATEWAY_NAME
  proxyProtocol: {}
EOF
  } | kubectl apply -f -
  if [[ "${PIPESTATUS[1]}" -ne 0 ]]; then
    echo "There was a problem configuring $GATEWAY_NAME..."
    exit 1
  fi
  if [[ "$SHARED_GATEWAY_NEW" = "true" ]]; then
    recordInstalled shared_gateway
  fi
  waitForGatewayService
}
if [[ "$GATEWAY_MODE" = "shared" ]]; then
  applySharedGateway
fi

# Set up nginx reverse proxy
# Sets up nginx to forward ports 80 (and 443 with TLS) to the Gateway's Envoy Service (GATEWAY_ADDRESS).
function configureNginx() {
  if [[ -e /etc/redhat-release ]]; then
    # RHEL/Fedora package the stream module as nginx-mod-stream (libnginx-mod-stream is Debian's name).
    if ! rpm -q nginx >/dev/null 2>&1; then
      echo "Installing nginx for reverse proxy..."
      if ! sudo dnf install nginx nginx-mod-stream -y; then
        echo "There was a problem installing nginx reverse proxy."
        exit 1
      fi
      recordInstalled nginx dnf
    elif ! rpm -q nginx-mod-stream >/dev/null 2>&1; then
      # An nginx built with the stream module (e.g. nginx.org's packages) has no such package; `nginx -t` below tells.
      echo "Installing the nginx stream module..."
      sudo dnf install nginx-mod-stream -y
    fi
  else
    if [[ `dpkg-query -W -f='${Status}' nginx 2>/dev/null` != "install ok installed" ]]; then
      echo "Installing nginx for reverse proxy..."
      if ! sudo apt-get install nginx libnginx-mod-stream -y; then
        echo "There was a problem installing nginx reverse proxy."
        exit 1
      fi
      recordInstalled nginx apt
    elif [[ `dpkg-query -W -f='${Status}' libnginx-mod-stream 2>/dev/null` != "install ok installed" ]]; then
      echo "Installing the nginx stream module..."
      sudo apt-get install libnginx-mod-stream -y
    fi
  fi

  if [[ -n "`activeFirewall`" ]]; then
    echo "Opening SMTP, HTTP${GATEWAY_TLS:+, HTTPS} and TURN in `activeFirewall`..."
    # Port 25 reaches Postfix through k3s' ServiceLB (the chart's "postfix" LoadBalancer Service).
    firewallOpenPort 25/tcp
    firewallOpenPort 80/tcp
    if [[ "$GATEWAY_TLS" = "true" ]]; then
      firewallOpenPort 443/tcp
    fi
    # The chart's bundled coturn (values.yaml's coturn) listens on the host's own network for the Video Conferencing plugin:
    # coturn.port over TCP and UDP, coturn.relayPorts over UDP, and coturn.tls.port over TCP for TURN over TLS (on by default: it
    # uses the certificate the chart issues for $SERVER_HOST, so it is served whenever GATEWAY_TLS is; with --tls false coturn runs
    # without TLS and 5349 stays unused). These are the chart's defaults. Port 443 stays nginx's: TURN on it would take an nginx
    # `stream` route on the TLS server name (see the README's "Video calls").
    firewallOpenPort 3478/tcp
    firewallOpenPort 3478/udp
    firewallOpenPort 5349/tcp
    firewallOpenPort 49152-49252/udp
  fi
  # SELinux (RHEL/Fedora) only lets nginx connect to other hosts' HTTP ports (the Gateway's ports 80 and 443) with this
  # boolean. Debian's AppArmor has no nginx profile by default, so there's nothing to do there.
  if command -v getenforce >/dev/null 2>&1 && [[ `getenforce` = "Enforcing" ]] \
      && [[ `getsebool httpd_can_network_relay 2>/dev/null` = *off ]]; then
    echo "Allowing nginx to relay connections (SELinux httpd_can_network_relay)..."
    if sudo setsebool -P httpd_can_network_relay 1; then
      recordInstalled selinux_nginx_relay
    fi
  fi

  # Check if we've already written to this file before
  if ! sudo grep -qxF "$NGINX_BEGIN" "$NGINX_CONF" && sudo grep -Eq '^[[:space:]]*stream[[:space:]]*\{' "$NGINX_CONF"; then
    # Written by an earlier version of this script (without markers) or by hand: don't add a second stream block.
    echo "$NGINX_CONF already has a stream {} block this script didn't write; make sure it forwards port 80 to" \
      "$GATEWAY_ADDRESS:80${GATEWAY_TLS:+ and port 443 to $GATEWAY_ADDRESS:443} with proxy_protocol on, then re-run."
  else
    if [[ ! -f "$NGINX_CONF.bak" ]]; then
      echo "Backing up nginx.conf..."
      sudo cp "$NGINX_CONF" "$NGINX_CONF.bak"
    fi
    echo "Writing nginx configuration..."
    # The stream proxy takes port 80 (and 443) for the Gateway, so no http server may listen there.
    disablePort80HttpServers
    # The shared Gateway's policy makes Envoy expect the PROXY header on both its ports. The chart's Gateways share one
    # Envoy, and Envoy Gateway refuses a policy on the HTTP listeners of Gateways that share a port, so only their HTTPS
    # listeners expect it (see the policies below): plain HTTP reaches Envoy without it, and shows nginx's address rather
    # than the client's.
    PROXY_PROTOCOL_80="
        proxy_protocol on;"
    if [[ "$GATEWAY_MODE" = "chart" ]]; then
      PROXY_PROTOCOL_80=""
    fi
    # A host name with an AAAA record is tried over IPv6 first, by browsers and by Let's Encrypt alike, so listen there too
    # when the host has IPv6.
    LISTEN6_80=""
    LISTEN6_443=""
    if [[ -e /proc/net/if_inet6 && "`cat /proc/sys/net/ipv6/conf/all/disable_ipv6 2>/dev/null`" != "1" ]]; then
      LISTEN6_80="
        listen [::]:80;"
      LISTEN6_443="
        listen [::]:443;"
    fi
    # Port 443 is only forwarded when the Gateway has HTTPS listeners (see GATEWAY_TLS above).
    HTTPS_SERVER=""
    if [[ "$GATEWAY_TLS" = "true" ]]; then
      HTTPS_SERVER="
    server {
        listen 443;$LISTEN6_443
        proxy_pass $GATEWAY_ADDRESS:443;
        proxy_protocol on;
    }"
    fi
    # Replace the block from an earlier run (the Gateway's Service address may have changed).
    sudo sed -i "/^$NGINX_BEGIN\$/,/^$NGINX_END\$/d" "$NGINX_CONF"
    sudo tee -a "$NGINX_CONF" > /dev/null << EOF
$NGINX_BEGIN
stream {
    server {
        listen 80;$LISTEN6_80
        proxy_pass $GATEWAY_ADDRESS:80;$PROXY_PROTOCOL_80
    }$HTTPS_SERVER
}
$NGINX_END
EOF
  fi

  if sudo test -e /etc/nginx/sites-enabled/default; then
    # Debian's default site listens on port 80. Kept aside so --uninstall can put it back.
    sudo install -d -m 0755 "$STATE_DIR"
    sudo mv /etc/nginx/sites-enabled/default "$STATE_DIR/sites-enabled-default"
    recordInstalled nginx_default_site moved
  fi

  if ! sudo nginx -t; then
    echo "The nginx configuration is invalid (see above). Fix $NGINX_CONF and re-run."
    exit 1
  fi
  if ! sudo systemctl enable nginx >/dev/null 2>&1 || ! sudo systemctl restart nginx; then
    echo "There was a problem restarting nginx reverse proxy. Whatever listens on port 80 or 443 now (another web server,"
    echo "or a server block in /etc/nginx/conf.d/ or /etc/nginx/sites-enabled/ listening there) must be stopped or moved:"
    sudo ss -ltnp '( sport = :80 or sport = :443 )'
    exit 1
  fi
  echo "Checking the reverse proxy reaches the Gateway..."
  result=000
  startTime=`date +%s`
  while [[ $(( `date +%s` - startTime )) -lt 300 ]]; do
    # Any HTTP answer but 400 (a 404 before the chart's routes exist) means nginx reaches Envoy and Envoy accepts its PROXY
    # header. Envoy answers 400 when the header is sent and it isn't expecting one or the other way round, which is what
    # it does until its Gateway's policy is applied.
    result=`curl -s -o /dev/null -w "%{http_code}" http://localhost`
    if [[ "$result" != "000" && "$result" != "400" ]]; then
      break
    fi
    echo "Waiting for the reverse proxy..."
    sleep 2
  done
  if [[ "$result" = "000" || "$result" = "400" ]]; then
    if [[ "$result" = "400" ]]; then
      echo "There was a problem configuring nginx reverse proxy: Envoy answers http://localhost with 400, so it doesn't accept"
      echo "the PROXY protocol header nginx sends (or expects one it doesn't get). Check the ClientTrafficPolicies with"
      echo "  kubectl get clienttrafficpolicy -A"
    else
      echo "There was a problem configuring nginx reverse proxy: http://localhost doesn't answer."
    fi
    echo "Check the Envoy pods with"
    echo "  kubectl -n $ENVOY_NAMESPACE get pods -l $ENVOY_SELECTOR"
    exit 1
  fi
  echo "Reverse proxy is setup."
}

# In "shared" mode the Gateway is already there; in "chart" mode it comes with the chart, so nginx is set up after it.
if [[ "$GATEWAY_MODE" = "shared" ]]; then
  run_step "Installing nginx reverse proxy"
  configureNginx
fi

# The JWT secret (shared with the auth-server), the ingest secret (shared with postfix-bridge) and the cookie, session
# and escrow audit keys. Whatever the release already uses is kept - in the vault or in Kubernetes Secrets - so neither a
# re-run nor the move into OpenBao signs anyone out or breaks the escrow audit log's hash chain.
AUTH_SECRET=${AUTH_SECRET:-`existingSecret jwt-auth auth__secret`}
AUTH_SECRET=${AUTH_SECRET:-`openssl rand -hex 32`}
MAIL_INGEST_SECRET=${MAIL_INGEST_SECRET:-`existingSecret mail-ingest-secret mail__transport__ingest__secret`}
MAIL_INGEST_SECRET=${MAIL_INGEST_SECRET:-`openssl rand -hex 32`}

if [[ "$OPENBAO" = "true" ]]; then
  COOKIE_SECRET=`existingSecret service-secrets cookie_secret`
  COOKIE_SECRET=${COOKIE_SECRET:-`openssl rand -hex 32`}
  SESSION_SECRET=`existingSecret service-secrets session__secret`
  SESSION_SECRET=${SESSION_SECRET:-`openssl rand -hex 32`}
  ESCROW_HMAC_KEY=`existingSecret service-secrets mail__escrow__audit_hmac_key`
  ESCROW_HMAC_KEY=${ESCROW_HMAC_KEY:-`openssl rand -hex 32`}

  if [[ "$OPENBAO_INSTALL" = "true" ]]; then
    run_step "Installing OpenBao"
    installOpenbao
    prepareOpenbao
    copyOpenbaoCa
    releaseKeyringSecret
  else
    echo "Keeping this release's secrets in the OpenBao at $OPENBAO_ADDRESS."
    echo "It must already hold them at $OPENBAO_KV_MOUNT/$OPENBAO_SECRETS_PATH, with the Secret $OPENBAO_ESO_SECRET in"
    echo "namespace $NAMESPACE holding a token that may read them - see README.md. It must also hold the configuration"
    echo "keyring at $OPENBAO_KV_MOUNT/$OPENBAO_KEYRING_PATH (the property keyring), which that token may read and the server's"
    echo "login may read and update; an installation that already encrypts values needs the keyring.json of its Secret"
    echo "$KEYRING_SECRET there, and that Secret deleted - see README.md."
    if [[ -n "$OPENBAO_CA_FILE" ]]; then
      copyOpenbaoCa
    fi
  fi

  # External Secrets is what copies the vault's values into the Kubernetes Secrets the pods read (the chart's
  # externalSecrets values). Its CRDs are cluster-wide, so it can't come from the chart; installCRDs is the chart's own
  # default but is set here so an existing install without them is corrected.
  run_step "Installing external-secrets"
  addHelmRepo external-secrets https://charts.external-secrets.io
  helm repo update external-secrets >/dev/null
  if helm status external-secrets -n external-secrets >/dev/null 2>&1; then
    echo "external-secrets is already installed."
  elif helm install external-secrets external-secrets/external-secrets --version "$EXTERNAL_SECRETS_VERSION" \
      -n external-secrets --create-namespace --set installCRDs=true; then
    recordInstalled external_secrets
  else
    echo "There was a problem installing external-secrets."
    exit 1
  fi
  waitForDeployments external-secrets external-secrets
fi

run_step "Installing RapidMX server"
# Installs or upgrades the release (the first time without openpgpkey.<domain> when its record is yet to be published: see decideOpenpgpkeyHost).
function installRelease() {
  # A published chart carries its dependencies; a local checkout may need them fetched (Chart.yaml's "@bitnami" repos).
  CHART_VERSION_ARGS=(--version "$VERSION")
  if [[ -d "$CHART" ]]; then
    CHART_VERSION_ARGS=()
    if helm dependency list "$CHART" 2>/dev/null | grep -qw missing; then
      addHelmRepo bitnami https://charts.bitnami.com/bitnami
      if ! helm dependency build "$CHART"; then
        echo "There was a problem fetching the dependencies of $CHART."
        exit 1
      fi
    fi
  fi

  # Secrets go to helm in a values file only this user can read (deleted on exit), never on the command line, where any
  # local user could read them from the process list.
  VALUES_FILE=`mktemp "${TMPDIR:-/tmp}/mail-server-values.XXXXXX"`
  chmod 600 "$VALUES_FILE"
  {
    if [[ "$OPENBAO" != "true" ]]; then
      # With OpenBao these live in the vault, and External Secrets - not this file - puts them in front of the pods.
      printf 'global:\n  jwt:\n    secret: %s\n' "`yamlQuote "$AUTH_SECRET"`"
      printf '  mailIngestSecret: %s\n' "`yamlQuote "$MAIL_INGEST_SECRET"`"
    fi
    # In the values file rather than --set, which would split the domain list on its commas.
    printf 'postfixBridge:\n  hostname: %s\n  domains: %s\n' "`yamlQuote "$SERVER_HOST"`" "`yamlQuote "$MAIL_DOMAINS"`"
    # Without cert-manager (--tls false) Postfix gets a self-signed certificate. With it, Postfix's host name is the
    # server's, so it presents the certificate the chart already has cert-manager issue for that name rather than getting
    # a second one (Let's Encrypt limits duplicates).
    printf '  tls:\n    certManager:\n      enabled: %s\n' "$TLS"
    if [[ "$GATEWAY_TLS" = "true" ]]; then
      printf '    existingSecret: %s\n' "`yamlQuote "$SERVER_HOST-tls-cert"`"
    fi
    # DNS publishing: the provider config the server creates and the mail host's addresses (nothing secret; the credentials are in a Secret).
    dnsHelmValues
  } > "$VALUES_FILE"

  if ! helm status "$NAMESPACE" -n "$NAMESPACE" >/dev/null 2>&1; then
    RELEASE_NEW=true
  fi
  # global.gateway is shared with the auth-server subchart, so both charts attach to the same Gateway ("shared") or each
  # make their own ("chart", where the name and namespace stay at their defaults). Sign-in redirects browsers to
  # authserver.host. global.gateway.hsts stays true (browsers ignore HSTS over plain HTTP anyway): false renders a response
  # header filter chart versions up to 1.0.0-beta.2 wrote for nginx-gateway only.
  GATEWAY_ARGS=(--set global.gateway.className="$GATEWAY_CLASS")
  if [[ "$GATEWAY_MODE" = "shared" ]]; then
    GATEWAY_ARGS+=(--set global.gateway.name="$GATEWAY_NAME" --set global.gateway.namespace="$GATEWAY_NAMESPACE")
  fi
  # Where the release's secrets come from: the vault, or the Kubernetes Secrets the chart renders itself. The vault this script
  # installs is reached over TLS (its CA copied into $OPENBAO_CA_CONFIGMAP) and logged in to with Kubernetes auth: External
  # Secrets as $OPENBAO_ESO_SERVICE_ACCOUNT, the server as its own ServiceAccount. A vault of your own keeps its token Secret.
  OPENBAO_ARGS=(--set global.openbao.enabled=false)
  if [[ "$OPENBAO" = "true" ]]; then
    OPENBAO_ARGS=(--set global.openbao.enabled=true
      --set global.openbao.address="$OPENBAO_ADDRESS"
      --set global.openbao.kvMount="$OPENBAO_KV_MOUNT"
      --set global.openbao.secretsPath="$OPENBAO_SECRETS_PATH"
      --set configEncryption.openbao.path="$OPENBAO_KEYRING_PATH"
      --set openbao.pki.mount="$OPENBAO_PKI_MOUNT"
      --set openbao.pki.role="$OPENBAO_PKI_ROLE")
    if [[ "$OPENBAO_INSTALL" = "true" ]]; then
      OPENBAO_ARGS+=(--set global.openbao.auth.method=kubernetes
        --set global.openbao.auth.kubernetes.role="$OPENBAO_ESO_ROLE"
        --set global.openbao.auth.kubernetes.serviceAccount="$OPENBAO_ESO_SERVICE_ACCOUNT"
        --set global.openbao.auth.kubernetes.audience="$OPENBAO_AUDIENCE"
        --set openbao.auth.method=kubernetes
        --set openbao.auth.role="$OPENBAO_SERVER_ROLE"
        --set openbao.auth.audience="$OPENBAO_AUDIENCE")
    else
      OPENBAO_ARGS+=(--set global.openbao.auth.method=token --set global.openbao.auth.tokenSecret="$OPENBAO_ESO_SECRET")
    fi
    if [[ "$OPENBAO_INSTALL" = "true" || -n "$OPENBAO_CA_FILE" ]]; then
      OPENBAO_ARGS+=(--set global.openbao.caConfigMap="$OPENBAO_CA_CONFIGMAP")
    fi
  fi
  if ! helm upgrade --install --create-namespace --namespace "$NAMESPACE" "$NAMESPACE" "$CHART" "${CHART_VERSION_ARGS[@]}" \
    --set global.domain="$DOMAIN" --set host="$SERVER_HOST" --set global.serverHost="$SERVER_HOST" \
    "${OPENBAO_ARGS[@]}" \
    --set global.gateway.tls="$GATEWAY_TLS" --set global.gateway.hsts=true "${GATEWAY_ARGS[@]}" \
    --set authserver.host="$AUTH_HOST" \
    --set mail.wkd.openpgpkeyHost.enabled="$OPENPGPKEY_ON" \
    --set-json "global.corsHosts=[\"$SERVER_HOST\",\"$AUTH_HOST\"]" \
    -f "$VALUES_FILE"; then
    echo "There was a problem installing the RapidMX server."
    if [[ -n "$DNS_PROVIDER" && -z "$DNS_CONTROLLER_TAG" && -z "$DNS_CONTROLLER_DIGEST" ]]; then
      echo "With --dns-provider the chart needs the DNS controller's image (dns.controller.image) pinned to a released version: if the message above says"
      echo "it is empty, set DNS_CONTROLLER_TAG (or DNS_CONTROLLER_DIGEST)."
    fi
    exit 1
  fi
  if [[ "$RELEASE_NEW" = "true" ]]; then
    recordInstalled release "$NAMESPACE"
  fi
  rm -f "$VALUES_FILE"
  VALUES_FILE=""
}

notePublishingBefore
if [[ -n "$DNS_PROVIDER" ]]; then
  # Before the release: the CRD external-dns reads, and the credentials the server turns into the provider config when it starts.
  installDnsCrd
  createDnsBootstrapSecret
fi
installRelease

if [[ "$OPENBAO_INSTALL" = "true" ]]; then
  # The release logs in with Kubernetes auth now; the tokens an earlier version of this script made are revoked once it does.
  migrateOpenbaoTokens
  checkOpenbaoCertificate
fi

if [[ "$GATEWAY_MODE" = "chart" ]]; then
  # The chart's own Gateways are up now. Like the shared one, their HTTPS listeners may only be reached through nginx,
  # which sends the PROXY protocol header, so each Gateway's is told to expect it. (Not the HTTP ones: see configureNginx.)
  # The shared Gateway of an earlier "shared" install is removed (its policy goes with it) so it stops holding on to the
  # listeners' hostnames.
  if [[ "`installedBy shared_gateway`" = "true" ]]; then
    kubectl -n "$GATEWAY_NAMESPACE" delete clienttrafficpolicy "$GATEWAY_NAME-proxy-protocol" --ignore-not-found
    kubectl -n "$GATEWAY_NAMESPACE" delete gateway "$GATEWAY_NAME" --ignore-not-found
  fi
  for gateway in `kubectl -n "$NAMESPACE" get gateway -o jsonpath='{.items[*].metadata.name}'`; do
    if [[ "$GATEWAY_TLS" != "true" ]]; then
      break
    fi
    if ! kubectl apply -f - << EOF
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: ClientTrafficPolicy
metadata:
  name: $gateway-proxy-protocol
  namespace: $NAMESPACE
spec:
  targetRefs:
  - group: gateway.networking.k8s.io
    kind: Gateway
    name: $gateway
    sectionName: https
  proxyProtocol: {}
EOF
    then
      echo "There was a problem configuring the Gateway $gateway..."
      exit 1
    fi
  done
  waitForGatewayService
  run_step "Installing nginx reverse proxy"
  configureNginx
else
  # The chart no longer creates Gateways, so the policies an earlier "chart" install made for them have nothing to target.
  kubectl -n "$NAMESPACE" delete clienttrafficpolicy --all --ignore-not-found >/dev/null
fi

if [[ -n "$DNS_PROVIDER" ]]; then
  # The server stores the DNS credentials when it starts and the controller publishes what the server asks for. openpgpkey.<domain>, when its
  # record was yet to be published, is served now that the controller has had the time to publish it.
  finishDnsBootstrap
  waitForDnsController
  enableOpenpgpkeyHost
fi

# Stop background loop
running=false
if [[ -n "$progress_pid" ]]; then
  wait "$progress_pid"
fi

echo "Installation complete."
DOMAINS_SEEDED=`seedDomains | paste -sd, -`
SCHEME=http
if [[ "$GATEWAY_TLS" = "true" ]]; then
  SCHEME=https
fi
echo "The server is at $SCHEME://$SERVER_HOST, with sign-in at $SCHEME://$AUTH_HOST."
echo "Postfix listens on port 25 as $SERVER_HOST and knows $MAIL_DOMAINS. Your domains ($DOMAINS_SEEDED) are in the admin console already: each one"
echo "receives, sends and signs mail once its DNS records are published (its MX record points at $SERVER_HOST). Domains you add there later work"
echo "the same, with nothing to restart. (A deployment that had domains before keeps them as they are: add any that is missing in the console.)"
if [[ "$OPENBAO" = "true" ]]; then
  echo "The release's secrets live in OpenBao at $OPENBAO_KV_MOUNT/$OPENBAO_SECRETS_PATH, and External Secrets keeps them"
  echo "in the Kubernetes Secrets the pods read, so a helm upgrade doesn't have to pass any of them. Read one with:"
  echo "  kubectl -n $OPENBAO_NAMESPACE exec -it $OPENBAO_POD -- env BAO_TOKEN=<root token> bao kv get -mount=$OPENBAO_KV_MOUNT $OPENBAO_SECRETS_PATH"
  if [[ "$OPENBAO_INSTALL" = "true" ]]; then
    echo "OpenBao listens with TLS only (its certificate, from a CA of its own, renews itself), and External Secrets and the"
    echo "server log in to it with short-lived tokens of their own ServiceAccounts: no long-lived token is kept anywhere."
    echo "The vault's unseal key and root token are in the $OPENBAO_KEYS_SECRET Secret in namespace $OPENBAO_NAMESPACE, which"
    echo "the openbao-unsealer Deployment uses to unseal it after a restart. Back that Secret up: without it the vault's"
    echo "contents can't be recovered."
  fi
else
  echo "Re-running this script reuses the release's secrets. To upgrade with helm yourself, pass them again as"
  echo "global.jwt.secret and global.mailIngestSecret:"
  echo "  kubectl -n $NAMESPACE get secret $FULLNAME-jwt-auth -o jsonpath='{.data.auth__secret}' | base64 -d"
  echo "  kubectl -n $NAMESPACE get secret $FULLNAME-mail-ingest-secret -o jsonpath='{.data.mail__transport__ingest__secret}' | base64 -d"
fi
echo "Back up the configuration keyring together with the database: the credentials, API keys and tokens saved in the admin console are"
echo "encrypted with it in the database, which is useless without it."
if [[ "$OPENBAO" = "true" ]]; then
  echo "It is the OpenBao secret $OPENBAO_KV_MOUNT/$OPENBAO_KEYRING_PATH (External Secrets keeps it in the Secret $KEYRING_SECRET, which the pods mount)."
  if [[ "$OPENBAO_INSTALL" = "true" ]]; then
    echo "  kubectl -n $OPENBAO_NAMESPACE exec -it $OPENBAO_POD -- env BAO_TOKEN=<root token> bao kv get -mount=$OPENBAO_KV_MOUNT -field=keyring $OPENBAO_KEYRING_PATH"
  fi
else
  echo "It is the Secret $KEYRING_SECRET in namespace $NAMESPACE, which a helm upgrade leaves in place, and --uninstall too unless k3s takes the whole cluster with it:"
  echo "  kubectl -n $NAMESPACE get secret $KEYRING_SECRET -o jsonpath='{.data.keyring\\.json}' | base64 -d"
fi

if [[ -n "$DNS_PROVIDER" ]]; then
  printDnsSummary
else
  reportPublishingTurnedOff
  printManualDnsRecords
fi
