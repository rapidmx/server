#!/usr/bin/env bash
###############################################################################
# Copyright (C) 2026 Jean-Philippe Steinmetz
# SPDX-License-Identifier: MPL-2.0
###############################################################################
#
# Installs a complete RapidMX server on one EC2 instance, for the CloudFormation template next to this file
# (rapidmx-server.yaml), which runs it from the instance's user data. Everything is read from environment variables and
# the instance metadata service; nothing is prompted for, and nothing is read from stdin (so `curl ... | bash` works).
#
#   k3s (no ServiceLB, no in-tree cloud controller) -> aws-cloud-controller-manager (Services of type LoadBalancer
#   become Classic Load Balancers) and aws-ebs-csi-driver (volumes become EBS) -> Envoy Gateway, whose Envoy Service is
#   a Classic Load Balancer forwarding TCP with the PROXY protocol -> cert-manager (the chart issues its certificates from
#   its own Let's Encrypt Issuer) -> the RapidMX server chart, sending mail through SES
#   (https://github.com/rapidmx/ses-bridge) rather than Postfix.
#
# single_node_install.sh is the equivalent for a bare-metal or on-premises host, where nginx on the host takes the place
# of the load balancer. This script is AWS-only, and deliberately has no uninstall: delete the CloudFormation stack.
#
# Required:
#   RAPIDMX_DOMAIN           The mail domain, e.g. example.com: the server is served at mail.<domain>, the auth-server
#                            at auth.<domain>, and mail is addressed @<domain>.
# Optional:
#   RAPIDMX_MAIL_HOST        The server's own host name, or just its label (default mail, i.e. mail.<domain>).
#   RAPIDMX_AUTH_HOST        The auth-server's host name, or just its label (default auth, i.e. auth.<domain>).
#   RAPIDMX_ACME_EMAIL       Let's Encrypt account email (default admin@<domain>).
#   RAPIDMX_TLS              "true" (default) issues certificates through Let's Encrypt; "false" serves plain HTTP.
#   RAPIDMX_NAMESPACE        Release name and namespace (default rapidmx-server).
#   RAPIDMX_CHART            Chart reference (default oci://ghcr.io/rapidmx/charts/server).
#   RAPIDMX_CHART_VERSION    Chart version (default 1.0.0-beta.3).
#   RAPIDMX_AUTH_SECRET      JWT secret shared with auth-server (default: generated).
#   RAPIDMX_INGEST_SECRET    /internal/mta bearer secret, shared with ses-bridge (default: generated).
#   RAPIDMX_HOSTED_ZONE_ID   Route 53 hosted zone to write the domain's records into (default: none - do it yourself).
#   RAPIDMX_INGEST_CIDRS     Comma-separated CIDRs allowed to reach /internal/mta (default: the VPC's own CIDR).
#   RAPIDMX_WEB_CIDRS        Comma-separated CIDRs allowed to reach HTTP/HTTPS (default: everywhere).
#   RAPIDMX_SES_REGION       Region SES sends from (default: this instance's region).
#   RAPIDMX_SES_SMTP_USERNAME, RAPIDMX_SES_SMTP_PASSWORD
#                            SES SMTP credentials (SES console > SMTP settings; the instance's IAM role can't be used for
#                            SMTP). The auth-server can only send its sign-in and verification codes over SMTP, so it
#                            sends them through SES's SMTP endpoint with these; without them its e-mail stays unconfigured.
#                            Kept in the Secret <fullname>-smtp.
#   RAPIDMX_MAIL_FROM        The address those codes come from (default noreply@<domain>, a verified SES identity's domain).
#   RAPIDMX_STORAGE_CLASS    Storage class for the volumes (default gp3, created here).
#   RAPIDMX_OPENBAO          "true" (default) installs OpenBao and keeps the release's secrets and its mail encryption
#                            CA in it; "false" keeps them in Kubernetes Secrets.
#   RAPIDMX_OPENBAO_ADDRESS  An OpenBao this cluster already runs, used instead of installing one - the kv path, PKI
#                            mount and token Secrets are then yours to create (see deploy/aws/README.md).
#   RAPIDMX_CLUSTER_NAME     The kubernetes.io/cluster/<name> tag on this instance and its subnets (default rapidmx).
#   ENVOY_GATEWAY_VERSION    Envoy Gateway release (default v1.9.1).
#   EXTERNAL_SECRETS_VERSION The External Secrets release (default 2.10.0), which delivers the chart's OpenBao-held
#                            secrets into the Kubernetes Secrets the pods read.
#   RAPIDMX_SUMMARY_FILE     Where the summary is written (default /var/lib/rapidmx-installer/summary.txt).
#
set -o pipefail

DOMAIN=${RAPIDMX_DOMAIN:-}
MAIL_HOST=${RAPIDMX_MAIL_HOST:-mail}
AUTH_HOST=${RAPIDMX_AUTH_HOST:-auth}
TLS=${RAPIDMX_TLS:-true}
NAMESPACE=${RAPIDMX_NAMESPACE:-rapidmx-server}
CHART=${RAPIDMX_CHART:-oci://ghcr.io/rapidmx/charts/server}
CHART_VERSION=${RAPIDMX_CHART_VERSION:-1.0.0-beta.3}
HOSTED_ZONE_ID=${RAPIDMX_HOSTED_ZONE_ID:-}
INGEST_CIDRS=${RAPIDMX_INGEST_CIDRS:-}
WEB_CIDRS=${RAPIDMX_WEB_CIDRS:-0.0.0.0/0}
STORAGE_CLASS=${RAPIDMX_STORAGE_CLASS:-gp3}
# OpenBao (https://openbao.org) holds the release's secrets - the JWT secret it shares with the auth-server, the cookie,
# session and escrow audit keys, the ses-bridge ingest secret - and the CA that issues certificates for end-to-end
# encrypted mail. Installed here rather than by the chart, like cert-manager, because it's a cluster service.
OPENBAO=${RAPIDMX_OPENBAO:-true}
OPENBAO_ADDRESS=${RAPIDMX_OPENBAO_ADDRESS:-}
OPENBAO_VERSION=${OPENBAO_VERSION:-0.29.4}
OPENBAO_NAMESPACE=${OPENBAO_NAMESPACE:-openbao}
OPENBAO_IMAGE=${OPENBAO_IMAGE:-openbao/openbao:2.6.2}
OPENBAO_STORAGE_SIZE=${OPENBAO_STORAGE_SIZE:-1Gi}
OPENBAO_POD=openbao-0
OPENBAO_LOCAL_ADDRESS=http://127.0.0.1:8200
# Holds the unseal key and the root token, which is what lets the vault unseal itself after a restart.
OPENBAO_KEYS_SECRET=openbao-keys
OPENBAO_KV_MOUNT=${OPENBAO_KV_MOUNT:-secret}
OPENBAO_PKI_MOUNT=${OPENBAO_PKI_MOUNT:-pki}
OPENBAO_PKI_ROLE=${OPENBAO_PKI_ROLE:-rapidmx-encryption}
CLUSTER_NAME=${RAPIDMX_CLUSTER_NAME:-rapidmx}
ENVOY_GATEWAY_VERSION=${ENVOY_GATEWAY_VERSION:-v1.9.1}
EXTERNAL_SECRETS_VERSION=${EXTERNAL_SECRETS_VERSION:-2.10.0}
SUMMARY_FILE=${RAPIDMX_SUMMARY_FILE:-/var/lib/rapidmx-installer/summary.txt}
GATEWAY_NAMESPACE=envoy-gateway-system
GATEWAY_NAME=shared-gateway
AWS_CCM_REPO=${AWS_CCM_REPO:-https://kubernetes.github.io/cloud-provider-aws}
AWS_EBS_CSI_REPO=${AWS_EBS_CSI_REPO:-https://kubernetes-sigs.github.io/aws-ebs-csi-driver}
K3S_KUBECONFIG=/etc/rancher/k3s/k3s.yaml
VALUES_FILE=""

export KUBECONFIG=$K3S_KUBECONFIG
export HOME=${HOME:-/root}

function log() {
  # Plain, timestamped lines: this runs unattended, and its output is read in cloud-init-output.log.
  echo "[rapidmx $(date -u +%H:%M:%S)] $*"
}

function fail() {
  echo "[rapidmx] ERROR: $*" >&2
  exit 1
}

function cleanup() {
  if [[ -n "$VALUES_FILE" ]]; then
    rm -f "$VALUES_FILE"
  fi
}
trap cleanup EXIT INT TERM

# A value from the instance metadata service (IMDSv2), or nothing.
function metadata() {
  local token
  token=`curl -sf -m 5 -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 300' http://169.254.169.254/latest/api/token`
  if [[ -z "$token" ]]; then
    return 1
  fi
  curl -sf -m 5 -H "X-aws-ec2-metadata-token: $token" "http://169.254.169.254/latest/meta-data/$1"
}

# The host name for label $2 in domain $1: a bare label ("mail") becomes mail.<domain>, anything containing a dot is
# taken as the whole host name.
function hostFor() {
  case "$2" in
    *.*) echo "$2";;
    *) echo "$2.$1";;
  esac
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

# 32 random bytes as hex, from openssl or, where it isn't installed, the kernel.
function randomSecret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    od -An -tx1 -N32 /dev/urandom | tr -d ' \n'
  fi
}

# The value of key $2 in Secret $1 of the release's namespace, or nothing - so a re-run keeps the secrets the release
# already has instead of rotating them.
function existingSecret() {
  local name
  for name in "$NAMESPACE-$1" "$NAMESPACE-server-$1"; do
    local value
    value=`kubectl -n "$NAMESPACE" get secret "$name" -o jsonpath="{.data.$2}" 2>/dev/null | base64 -d 2>/dev/null`
    if [[ -n "$value" ]]; then
      echo "$value"
      return
    fi
  done
}

# Waits (up to 30 minutes) until namespace $1 has Deployments and all of them are Available.
function waitForDeployments() {
  local ns=$1
  local startTime
  startTime=`date +%s`
  until [[ `kubectl -n "$ns" get deployments --no-headers 2>/dev/null | wc -l` -gt 0 ]]; do
    if [[ $(( `date +%s` - startTime )) -ge 1800 ]]; then
      fail "no Deployment ever appeared in $ns."
    fi
    sleep 5
  done
  kubectl -n "$ns" wait --for=condition=Available deployment --all --timeout=30m || fail "$ns didn't become available."
}

# Reads field $1 (a jsonpath) of the Service Envoy Gateway created for the shared Gateway.
function gatewayService() {
  kubectl -n "$GATEWAY_NAMESPACE" get svc -o jsonpath="{.items[0]$1}" 2>/dev/null \
    -l "gateway.envoyproxy.io/owning-gateway-name=$GATEWAY_NAME,gateway.envoyproxy.io/owning-gateway-namespace=$GATEWAY_NAMESPACE"
}

# Installs OpenBao and leaves it initialised and unsealed, with the unseal key and root token in $OPENBAO_KEYS_SECRET and
# a small Deployment beside it that unseals the vault again whenever it comes back sealed - which a pod restart, an
# upgrade and an instance reboot all do. Keeping that key in a Secret is the trade for a vault that heals itself on an
# unattended instance: anyone who can read Secrets in that namespace can unseal it. A deployment that would rather
# auto-unseal from KMS should run its own vault and name it in RAPIDMX_OPENBAO_ADDRESS.
function installOpenbao() {
  log "Installing OpenBao $OPENBAO_VERSION..."
  helm repo add openbao https://openbao.github.io/openbao-helm >/dev/null 2>&1
  helm repo update openbao >/dev/null || fail "couldn't update the openbao helm repo."
  # Standalone with file storage on an EBS volume: one node, one vault. The sidecar injector is off - External Secrets
  # delivers the values instead.
  helm upgrade --install openbao openbao/openbao --version "$OPENBAO_VERSION" \
    -n "$OPENBAO_NAMESPACE" --create-namespace \
    --set injector.enabled=false \
    --set server.standalone.enabled=true \
    --set server.dataStorage.enabled=true \
    --set server.dataStorage.size="$OPENBAO_STORAGE_SIZE" \
    --set server.dataStorage.storageClass="$STORAGE_CLASS" || fail "the OpenBao install failed."

  # A sealed vault never reports Ready, and it is sealed until the next step, so this waits for the pod to answer rather
  # than for readiness. `bao status` exits non-zero while sealed but still prints the status, which is what's checked.
  local startTime
  startTime=`date +%s`
  until kubectl -n "$OPENBAO_NAMESPACE" exec "$OPENBAO_POD" -- bao status -address="$OPENBAO_LOCAL_ADDRESS" -format=json 2>/dev/null | grep -q '"sealed"'; do
    if [[ $(( `date +%s` - startTime )) -ge 600 ]]; then
      fail "$OPENBAO_POD in namespace $OPENBAO_NAMESPACE never answered."
    fi
    sleep 5
  done

  if kubectl -n "$OPENBAO_NAMESPACE" get secret "$OPENBAO_KEYS_SECRET" >/dev/null 2>&1; then
    OPENBAO_UNSEAL_KEY=`kubectl -n "$OPENBAO_NAMESPACE" get secret "$OPENBAO_KEYS_SECRET" -o jsonpath='{.data.unseal_key}' | base64 -d`
    OPENBAO_ROOT_TOKEN=`kubectl -n "$OPENBAO_NAMESPACE" get secret "$OPENBAO_KEYS_SECRET" -o jsonpath='{.data.root_token}' | base64 -d`
    [[ -n "$OPENBAO_UNSEAL_KEY" && -n "$OPENBAO_ROOT_TOKEN" ]] \
      || fail "the $OPENBAO_KEYS_SECRET Secret has no unseal_key/root_token, so this vault can't be unsealed from here."
  else
    log "Initialising OpenBao..."
    # One key share, because the thing that unseals this vault is a Deployment, not a group of people.
    local init
    init=`kubectl -n "$OPENBAO_NAMESPACE" exec "$OPENBAO_POD" -- bao operator init -address="$OPENBAO_LOCAL_ADDRESS" -key-shares=1 -key-threshold=1 -format=json` \
      || fail "couldn't initialise OpenBao."
    OPENBAO_UNSEAL_KEY=`printf '%s' "$init" | tr -d ' \n' | sed -n 's/.*"unseal_keys_b64":\["\([^"]*\)".*/\1/p'`
    OPENBAO_ROOT_TOKEN=`printf '%s' "$init" | tr -d ' \n' | sed -n 's/.*"root_token":"\([^"]*\)".*/\1/p'`
    [[ -n "$OPENBAO_UNSEAL_KEY" && -n "$OPENBAO_ROOT_TOKEN" ]] \
      || fail "OpenBao was initialised but its unseal key couldn't be read back, so nothing can unseal it."
    # Written from files, so neither value passes through this host's process list.
    local dir
    dir=`mktemp -d`
    chmod 700 "$dir"
    printf '%s' "$OPENBAO_UNSEAL_KEY" > "$dir/unseal_key"
    printf '%s' "$OPENBAO_ROOT_TOKEN" > "$dir/root_token"
    kubectl -n "$OPENBAO_NAMESPACE" create secret generic "$OPENBAO_KEYS_SECRET" \
      --from-file="$dir/unseal_key" --from-file="$dir/root_token" >/dev/null \
      || { rm -rf "$dir"; fail "couldn't store OpenBao's unseal key, which leaves a vault nothing can unseal."; }
    rm -rf "$dir"
  fi

  if ! kubectl -n "$OPENBAO_NAMESPACE" exec "$OPENBAO_POD" -- bao status -address="$OPENBAO_LOCAL_ADDRESS" -format=json 2>/dev/null | tr -d ' ' | grep -q '"sealed":false'; then
    # `bao operator unseal` takes the key only as an argument (it refuses stdin and, unlike Vault, "-"), so a shell in the
    # pod reads it from stdin and passes it on: it isn't in this host's process list.
    printf '%s\n' "$OPENBAO_UNSEAL_KEY" | kubectl -n "$OPENBAO_NAMESPACE" exec -i "$OPENBAO_POD" -- \
      sh -c 'read -r key && exec bao operator unseal -address="$1" "$key"' sh "$OPENBAO_LOCAL_ADDRESS" >/dev/null \
      || fail "couldn't unseal OpenBao."
  fi

  # The unsealer: it does nothing while the vault is unsealed, and unseals it within ten seconds of it coming back.
  cat << EOF | kubectl apply -f - >/dev/null || fail "couldn't install the OpenBao unsealer."
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
            - name: UNSEAL_KEY
              valueFrom:
                secretKeyRef:
                  name: $OPENBAO_KEYS_SECRET
                  key: unseal_key
          resources:
            requests:
              cpu: 10m
              memory: 32Mi
            limits:
              memory: 64Mi
          securityContext:
            allowPrivilegeEscalation: false
            capabilities:
              drop: ["ALL"]
EOF
  log "OpenBao is running and unsealed."
}

# Prepares the vault for this release: the kv v2 mount and this release's secrets, the PKI mount, issuing role and root
# CA the server signs mail encryption certificates from, and a token for each of its two clients - External Secrets
# (read-only on this release's secrets) and the server itself (sign and revoke on the PKI role, nothing else). It all
# runs inside the vault's own pod, over stdin, so no token or secret reaches either host's process list; re-running it
# changes nothing that already exists.
function prepareOpenbao() {
  local needEsoToken=true
  local needPkiToken=true
  if kubectl -n "$NAMESPACE" get secret "$OPENBAO_ESO_SECRET" >/dev/null 2>&1; then
    needEsoToken=false
  fi
  if kubectl -n "$NAMESPACE" get secret "$OPENBAO_PKI_SECRET" >/dev/null 2>&1; then
    needPkiToken=false
  fi
  local out
  out=`mktemp /tmp/openbao-tokens.XXXXXX`
  chmod 600 "$out"
  kubectl -n "$OPENBAO_NAMESPACE" exec -i "$OPENBAO_POD" -- sh -s > "$out" << EOF || { rm -f "$out"; fail "couldn't prepare OpenBao for this release."; }
set -e
export BAO_ADDR=$OPENBAO_LOCAL_ADDRESS
export BAO_TOKEN=`shQuote "$OPENBAO_ROOT_TOKEN"`

# The kv v2 engine the chart reads this release's secrets from (its global.openbao.kvMount).
bao secrets list -format=json | grep -q '"$OPENBAO_KV_MOUNT/"' || bao secrets enable -path=$OPENBAO_KV_MOUNT -version=2 kv > /dev/null

# A value already in the vault always wins, so an upgrade never re-keys anything.
seed() {
  if [ -n "\`bao kv get -mount=$OPENBAO_KV_MOUNT -field="\$1" $OPENBAO_SECRETS_PATH 2> /dev/null\`" ]; then
    return 0
  fi
  bao kv patch -mount=$OPENBAO_KV_MOUNT $OPENBAO_SECRETS_PATH "\$1=\$2" > /dev/null 2>&1 ||
    bao kv put -mount=$OPENBAO_KV_MOUNT $OPENBAO_SECRETS_PATH "\$1=\$2" > /dev/null
}
seed auth_secret `shQuote "$AUTH_SECRET"`
seed cookie_secret `shQuote "$COOKIE_SECRET"`
seed session__secret `shQuote "$SESSION_SECRET"`
seed escrow_audit_hmac_key `shQuote "$ESCROW_HMAC_KEY"`
seed mail_ingest_secret `shQuote "$INGEST_SECRET"`

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

printf 'path "$OPENBAO_KV_MOUNT/data/$OPENBAO_SECRETS_PATH" {\n  capabilities = ["read"]\n}\npath "$OPENBAO_KV_MOUNT/metadata/$OPENBAO_SECRETS_PATH" {\n  capabilities = ["read"]\n}\n' | bao policy write $FULLNAME-secrets-read - > /dev/null
printf 'path "$OPENBAO_PKI_MOUNT/sign/$OPENBAO_PKI_ROLE" {\n  capabilities = ["update"]\n}\npath "$OPENBAO_PKI_MOUNT/revoke" {\n  capabilities = ["update"]\n}\n' | bao policy write $FULLNAME-pki - > /dev/null

# Periodic tokens with a very long period: nothing here renews them, and a token that expires takes the deployment down
# with it. They are orphans so revoking the root token doesn't revoke them.
bao auth tune -max-lease-ttl=87600h token/ > /dev/null
if [ "$needEsoToken" = "true" ]; then
  echo "eso_token=\`bao token create -policy=$FULLNAME-secrets-read -orphan -period=87600h -display-name=$FULLNAME-eso -field=token\`"
fi
if [ "$needPkiToken" = "true" ]; then
  echo "pki_token=\`bao token create -policy=$FULLNAME-pki -orphan -period=87600h -display-name=$FULLNAME-pki -field=token\`"
fi
# What the vault ended up holding, which is what the summary has to report: a value already there wins over the one
# generated for this run, and ses-bridge must be given the real ingest secret.
echo "ingest_secret=\`bao kv get -mount=$OPENBAO_KV_MOUNT -field=mail_ingest_secret $OPENBAO_SECRETS_PATH\`"
echo "auth_secret=\`bao kv get -mount=$OPENBAO_KV_MOUNT -field=auth_secret $OPENBAO_SECRETS_PATH\`"
EOF

  # The Secrets the two tokens are read from. They belong to the release's namespace, which helm hasn't created yet.
  kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
  local dir token
  dir=`mktemp -d`
  chmod 700 "$dir"
  token=`sed -n 's/^eso_token=//p' "$out"`
  if [[ -n "$token" ]]; then
    printf '%s' "$token" > "$dir/token"
    kubectl -n "$NAMESPACE" create secret generic "$OPENBAO_ESO_SECRET" --from-file="$dir/token" >/dev/null
  fi
  token=`sed -n 's/^pki_token=//p' "$out"`
  if [[ -n "$token" ]]; then
    printf '%s' "$token" > "$dir/mail__pki__openbao__token"
    kubectl -n "$NAMESPACE" create secret generic "$OPENBAO_PKI_SECRET" --from-file="$dir/mail__pki__openbao__token" >/dev/null
  fi
  rm -rf "$dir"
  INGEST_SECRET=`sed -n 's/^ingest_secret=//p' "$out"`
  AUTH_SECRET=`sed -n 's/^auth_secret=//p' "$out"`
  rm -f "$out"
  log "OpenBao holds this release's secrets at $OPENBAO_KV_MOUNT/$OPENBAO_SECRETS_PATH."
}

# Upserts a CNAME from $1 to $2 in RAPIDMX_HOSTED_ZONE_ID.
function upsertCname() {
  local record=$1
  local target=$2
  local batch
  batch=`mktemp`
  cat > "$batch" << EOF
{"Comment": "RapidMX server", "Changes": [{"Action": "UPSERT", "ResourceRecordSet": {
  "Name": "$record", "Type": "CNAME", "TTL": 300, "ResourceRecords": [{"Value": "$target"}]}}]}
EOF
  if aws route53 change-resource-record-sets --hosted-zone-id "$HOSTED_ZONE_ID" --change-batch "file://$batch" >/dev/null; then
    log "Pointed $record at $target."
  else
    log "WARNING: couldn't create the $record record; create it yourself (CNAME to $target)."
  fi
  rm -f "$batch"
}

# --- Preflight ---------------------------------------------------------------------------------
[[ -n "$DOMAIN" ]] || fail "RAPIDMX_DOMAIN is required (the mail domain, e.g. example.com)."
[[ "$TLS" = "true" || "$TLS" = "false" ]] || fail "RAPIDMX_TLS must be true or false."
[[ "$OPENBAO" = "true" || "$OPENBAO" = "false" ]] || fail "RAPIDMX_OPENBAO must be true or false."
# With RAPIDMX_OPENBAO_ADDRESS the vault is yours: this script neither installs nor prepares one.
OPENBAO_INSTALL=false
if [[ "$OPENBAO" = "true" && -z "$OPENBAO_ADDRESS" ]]; then
  OPENBAO_INSTALL=true
  OPENBAO_ADDRESS="http://openbao.$OPENBAO_NAMESPACE.svc:8200"
fi
[[ `id -u` -eq 0 ]] || fail "This script must run as root (it is meant to run from EC2 user data)."
SERVER_HOST=`hostFor "$DOMAIN" "$MAIL_HOST"`
AUTH_HOST=`hostFor "$DOMAIN" "$AUTH_HOST"`
# The chart's resource prefix (its "rrst.fullname"): the release name, suffixed with "server" unless it already contains
# it. The vault's paths and token Secrets are named after it.
FULLNAME=$NAMESPACE
if [[ "$NAMESPACE" != *server* ]]; then
  FULLNAME="$NAMESPACE-server"
fi
OPENBAO_SECRETS_PATH="$FULLNAME/secrets"
OPENBAO_ESO_SECRET="$FULLNAME-openbao-eso"
OPENBAO_PKI_SECRET="$FULLNAME-openbao-pki"
ACME_EMAIL=${RAPIDMX_ACME_EMAIL:-admin@$DOMAIN}
SMTP_USERNAME=${RAPIDMX_SES_SMTP_USERNAME:-}
SMTP_PASSWORD=${RAPIDMX_SES_SMTP_PASSWORD:-}
MAIL_FROM=${RAPIDMX_MAIL_FROM:-noreply@$DOMAIN}

NODE_NAME=`metadata local-hostname` || fail "no EC2 instance metadata service - this script only runs on EC2."
[[ -n "$NODE_NAME" ]] || fail "the instance metadata service didn't return this instance's private DNS name."
REGION=${RAPIDMX_SES_REGION:-}
if [[ -z "$REGION" ]]; then
  REGION=`metadata placement/region`
fi
MAC=`metadata network/interfaces/macs/ | head -n 1 | tr -d /`
VPC_CIDR=`metadata "network/interfaces/macs/$MAC/vpc-ipv4-cidr-block"`
INGEST_CIDRS=${INGEST_CIDRS:-$VPC_CIDR}
log "Installing RapidMX server for $SERVER_HOST on $NODE_NAME (region ${REGION:-unknown})."

# --- Packages ----------------------------------------------------------------------------------
if command -v dnf >/dev/null 2>&1; then
  # Amazon Linux, RHEL, Fedora. tar and unzip are needed by helm's installer and the AWS CLI's.
  dnf install -y tar unzip curl >/dev/null || fail "couldn't install the base packages with dnf."
elif command -v apt-get >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq || fail "apt-get update failed."
  apt-get install -y -qq tar unzip curl >/dev/null || fail "couldn't install the base packages with apt-get."
else
  fail "no supported package manager (dnf or apt-get) found."
fi

if [[ -n "$HOSTED_ZONE_ID" ]] && ! command -v aws >/dev/null 2>&1; then
  log "Installing the AWS CLI (for the Route 53 records)..."
  ARCH=`uname -m`
  if curl -sfL "https://awscli.amazonaws.com/awscli-exe-linux-$ARCH.zip" -o /tmp/awscliv2.zip; then
    unzip -q -o /tmp/awscliv2.zip -d /tmp && /tmp/aws/install --update >/dev/null 2>&1
    rm -rf /tmp/awscliv2.zip /tmp/aws
  fi
  command -v aws >/dev/null 2>&1 || log "WARNING: couldn't install the AWS CLI; the DNS records will be left to you."
fi

# --- k3s ---------------------------------------------------------------------------------------
if [[ -x /usr/local/bin/k3s ]]; then
  log "k3s is already installed."
else
  log "Installing k3s..."
  # No ServiceLB and no in-tree cloud controller: aws-cloud-controller-manager below answers LoadBalancer Services with
  # real load balancers. The node name must be the instance's private DNS name, which is how it finds the instance.
  curl -sfL https://get.k3s.io | INSTALL_K3S_EXEC="--disable=traefik --disable=servicelb --disable-cloud-controller --kubelet-arg=cloud-provider=external --node-name=$NODE_NAME" sh - \
    || fail "k3s install failed."
fi
chmod 600 "$K3S_KUBECONFIG" 2>/dev/null

log "Waiting for the node to register..."
startTime=`date +%s`
until kubectl get nodes 2>/dev/null | grep -q "$NODE_NAME"; do
  if [[ $(( `date +%s` - startTime )) -ge 600 ]]; then
    fail "the k3s node never registered."
  fi
  sleep 5
done

# --- helm --------------------------------------------------------------------------------------
if ! command -v helm >/dev/null 2>&1; then
  log "Installing helm..."
  curl -sfL https://raw.githubusercontent.com/helm/helm/master/scripts/get-helm-3 | bash >/dev/null \
    || fail "helm install failed."
fi

# --- Cloud controller, EBS CSI driver, storage class --------------------------------------------
# Until the cloud controller runs, every node keeps the "uninitialized" taint and nothing else schedules. Both need the
# instance's IAM role to allow the EC2/ELB and EBS calls, and this instance and its subnets tagged
# kubernetes.io/cluster/$CLUSTER_NAME (the CloudFormation template does that).
log "Installing aws-cloud-controller-manager and aws-ebs-csi-driver..."
helm repo add aws-cloud-controller-manager "$AWS_CCM_REPO" >/dev/null 2>&1
helm repo add aws-ebs-csi-driver "$AWS_EBS_CSI_REPO" >/dev/null 2>&1
helm repo update aws-cloud-controller-manager aws-ebs-csi-driver >/dev/null || fail "couldn't update the helm repos."
if ! helm status aws-cloud-controller-manager -n kube-system >/dev/null 2>&1; then
  helm install aws-cloud-controller-manager aws-cloud-controller-manager/aws-cloud-controller-manager -n kube-system \
    --set args="{--v=2,--cloud-provider=aws,--configure-cloud-routes=false,--cluster-name=$CLUSTER_NAME}" \
    || fail "aws-cloud-controller-manager install failed."
fi
if ! helm status aws-ebs-csi-driver -n kube-system >/dev/null 2>&1; then
  helm install aws-ebs-csi-driver aws-ebs-csi-driver/aws-ebs-csi-driver -n kube-system \
    || fail "aws-ebs-csi-driver install failed."
fi
waitForDeployments kube-system

kubectl apply -f - << EOF || fail "couldn't create the $STORAGE_CLASS storage class."
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: $STORAGE_CLASS
provisioner: ebs.csi.aws.com
# The volume is created where the first pod using it is scheduled, in that pod's availability zone.
volumeBindingMode: WaitForFirstConsumer
allowVolumeExpansion: true
parameters:
  type: gp3
  encrypted: "true"
EOF

# --- Envoy Gateway -------------------------------------------------------------------------------
log "Installing envoy-gateway $ENVOY_GATEWAY_VERSION..."
if ! helm status eg -n "$GATEWAY_NAMESPACE" >/dev/null 2>&1; then
  helm install eg oci://docker.io/envoyproxy/gateway-helm --version "$ENVOY_GATEWAY_VERSION" \
    -n "$GATEWAY_NAMESPACE" --create-namespace || fail "envoy-gateway install failed."
fi
kubectl wait --timeout=5m -n "$GATEWAY_NAMESPACE" deployment/envoy-gateway --for=condition=Available \
  || fail "envoy-gateway didn't become available."

# The Envoy Service is a Classic Load Balancer (the default for a LoadBalancer Service with no aws-load-balancer-type
# annotation) passing TCP through, so Envoy still terminates TLS itself, and sending the PROXY protocol so the server
# sees each client's real address (the ClientTrafficPolicy below requires it).
kubectl apply -f - << EOF || fail "couldn't configure the envoy GatewayClass."
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: EnvoyProxy
metadata:
  name: aws-proxy
  namespace: $GATEWAY_NAMESPACE
spec:
  provider:
    type: Kubernetes
    kubernetes:
      envoyService:
        type: LoadBalancer
        annotations:
          service.beta.kubernetes.io/aws-load-balancer-proxy-protocol: "*"
          service.beta.kubernetes.io/aws-load-balancer-backend-protocol: tcp
          service.beta.kubernetes.io/aws-load-balancer-cross-zone-load-balancing-enabled: "true"
          # Who may reach the load balancer. The cloud controller puts these in the security group it creates for it.
          service.beta.kubernetes.io/load-balancer-source-ranges: "$WEB_CIDRS"
      # Envoy and its shutdown-manager are killed by the kubelet after three missed 1 s probes, and every restart resets
      # every connection. Found on a single-node k3s host, where it happened 40 or so times a day; the same tolerance costs
      # nothing here. Five seconds, six misses.
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
  name: envoy
spec:
  controllerName: gateway.envoyproxy.io/gatewayclass-controller
  parametersRef:
    group: gateway.envoyproxy.io
    kind: EnvoyProxy
    name: aws-proxy
    namespace: $GATEWAY_NAMESPACE
EOF

# HTTPS listeners terminate TLS with the "<host>-tls-cert" Secrets the chart has cert-manager issue in $NAMESPACE; the
# chart renders the ReferenceGrant that lets this Gateway use them, because it's told the listener names below.
HTTPS_LISTENER=""
AUTH_HTTPS_LISTENER=""
if [[ "$TLS" = "true" ]]; then
  HTTPS_LISTENER="https"
  AUTH_HTTPS_LISTENER="https-auth"
fi
{
cat << EOF
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: $GATEWAY_NAME
  namespace: $GATEWAY_NAMESPACE
spec:
  gatewayClassName: envoy
  listeners:
  - allowedRoutes:
      namespaces:
        from: All
    name: http
    port: 80
    protocol: HTTP
EOF
for listener in "$HTTPS_LISTENER:$SERVER_HOST" "$AUTH_HTTPS_LISTENER:$AUTH_HOST"; do
  if [[ "${listener%%:*}" != "" ]]; then
cat << EOF
  - allowedRoutes:
      namespaces:
        from: All
    name: ${listener%%:*}
    hostname: "${listener#*:}"
    port: 443
    protocol: HTTPS
    tls:
      mode: Terminate
      certificateRefs:
      - kind: Secret
        name: ${listener#*:}-tls-cert
        namespace: $NAMESPACE
EOF
  fi
done
cat << EOF
---
# Every connection to the Gateway comes from the load balancer, which sends the PROXY protocol header; others are
# refused, so the address Envoy reports (and the server rate limits on) can't be forged.
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
[[ "${PIPESTATUS[1]}" -eq 0 ]] || fail "couldn't configure $GATEWAY_NAME."

log "Waiting for the load balancer..."
LB_HOSTNAME=""
startTime=`date +%s`
while [[ $(( `date +%s` - startTime )) -lt 900 ]]; do
  LB_HOSTNAME=`gatewayService '.status.loadBalancer.ingress[0].hostname'`
  if [[ -n "$LB_HOSTNAME" ]]; then
    break
  fi
  sleep 10
done
if [[ -z "$LB_HOSTNAME" ]]; then
  kubectl -n "$GATEWAY_NAMESPACE" describe svc -l "gateway.envoyproxy.io/owning-gateway-name=$GATEWAY_NAME" | tail -20
  fail "the Envoy Service never got a load balancer. Check this instance's IAM role and its subnets' kubernetes.io tags."
fi
log "The load balancer is $LB_HOSTNAME."

# --- DNS ------------------------------------------------------------------------------------------
if [[ -n "$HOSTED_ZONE_ID" ]] && command -v aws >/dev/null 2>&1; then
  upsertCname "$SERVER_HOST" "$LB_HOSTNAME"
  upsertCname "$AUTH_HOST" "$LB_HOSTNAME"
fi

# --- cert-manager ---------------------------------------------------------------------------------
if [[ "$TLS" = "true" ]]; then
  log "Installing cert-manager..."
  helm upgrade --install cert-manager oci://quay.io/jetstack/charts/cert-manager --namespace cert-manager \
    --create-namespace --set config.apiVersion="controller.config.cert-manager.io/v1alpha1" \
    --set config.kind="ControllerConfiguration" --set config.enableGatewayAPI=true --set crds.enabled=true \
    || fail "cert-manager install failed."
  waitForDeployments cert-manager

  # The chart brings its own Issuer (and Certificate), registered with $ACME_EMAIL, so no ClusterIssuer is made here. Its
  # Issuer and Certificate are refused until cert-manager's webhook accepts requests, which can take a moment after its
  # Deployment is Available; a server-side dry run of an Issuer goes through the webhook without creating anything.
  startTime=`date +%s`
  until kubectl apply --dry-run=server -f - >/dev/null 2>&1 << EOF
apiVersion: cert-manager.io/v1
kind: Issuer
metadata:
  name: webhook-check
  namespace: default
spec:
  selfSigned: {}
EOF
  do
    if [[ $(( `date +%s` - startTime )) -ge 300 ]]; then
      fail "cert-manager's webhook isn't accepting requests."
    fi
    sleep 5
  done
fi

# --- The release's secrets ---------------------------------------------------------------------
# Whatever the release already uses is kept - in the vault or in Kubernetes Secrets - so neither a re-run nor the move
# into OpenBao signs anyone out or breaks the escrow audit log's hash chain.
AUTH_SECRET=${RAPIDMX_AUTH_SECRET:-`existingSecret jwt-auth auth__secret`}
AUTH_SECRET=${AUTH_SECRET:-`randomSecret`}
INGEST_SECRET=${RAPIDMX_INGEST_SECRET:-`existingSecret mail-ingest-secret mail__transport__ingest__secret`}
INGEST_SECRET=${INGEST_SECRET:-`randomSecret`}

if [[ "$OPENBAO" = "true" ]]; then
  COOKIE_SECRET=`existingSecret service-secrets cookie_secret`
  COOKIE_SECRET=${COOKIE_SECRET:-`randomSecret`}
  SESSION_SECRET=`existingSecret service-secrets session__secret`
  SESSION_SECRET=${SESSION_SECRET:-`randomSecret`}
  ESCROW_HMAC_KEY=`existingSecret service-secrets mail__escrow__audit_hmac_key`
  ESCROW_HMAC_KEY=${ESCROW_HMAC_KEY:-`randomSecret`}

  # --- OpenBao ---------------------------------------------------------------------------------
  if [[ "$OPENBAO_INSTALL" = "true" ]]; then
    installOpenbao
    prepareOpenbao
  else
    log "Keeping this release's secrets in the OpenBao at $OPENBAO_ADDRESS. It must already hold them at"
    log "$OPENBAO_KV_MOUNT/$OPENBAO_SECRETS_PATH, with the Secrets $OPENBAO_ESO_SECRET and $OPENBAO_PKI_SECRET in"
    log "namespace $NAMESPACE holding tokens that may read them."
  fi

  # --- External Secrets ------------------------------------------------------------------------
  # Copies what the vault holds into the Kubernetes Secrets the pods read. Cluster-wide CRDs, so it can't come from the
  # chart itself.
  log "Installing external-secrets $EXTERNAL_SECRETS_VERSION..."
  helm repo add external-secrets https://charts.external-secrets.io >/dev/null 2>&1
  helm repo update external-secrets >/dev/null || fail "couldn't update the external-secrets helm repo."
  if ! helm status external-secrets -n external-secrets >/dev/null 2>&1; then
    helm install external-secrets external-secrets/external-secrets --version "$EXTERNAL_SECRETS_VERSION" \
      -n external-secrets --create-namespace --set installCRDs=true || fail "external-secrets install failed."
  fi
  waitForDeployments external-secrets
fi

# --- The RapidMX server ------------------------------------------------------------------------

# The secrets go to helm in a file only root can read (deleted on exit), never on the command line, where any local user
# could read them from the process list.
VALUES_FILE=`mktemp /tmp/rapidmx-values.XXXXXX`
chmod 600 "$VALUES_FILE"
{
  printf 'global:\n'
  if [[ "$OPENBAO" != "true" ]]; then
    # With OpenBao these live in the vault, and External Secrets - not this file - puts them in front of the pods.
    printf '  jwt:\n    secret: %s\n  mailIngestSecret: %s\n' "`yamlQuote "$AUTH_SECRET"`" "`yamlQuote "$INGEST_SECRET"`"
  fi
  # The auth-server can only send its sign-in and verification codes through SMTP, so it uses SES's endpoint with an SMTP
  # account's credentials (from a Secret, below). Without that account its e-mail is left unconfigured rather than pointed at
  # an endpoint that would refuse it.
  printf '  smtp:\n    host: %s\n    port: 587\n    secure: false\n    ignoreTLS: false\n    requireTLS: true\n    from: %s\n' \
    "`yamlQuote "email-smtp.$REGION.amazonaws.com"`" "`yamlQuote "$MAIL_FROM"`"
  printf 'common:\n  storageClass: %s\n' "`yamlQuote "$STORAGE_CLASS"`"
  printf 'authserver:\n  service:\n'
  if [[ -n "$SMTP_USERNAME" && -n "$SMTP_PASSWORD" ]]; then
    printf '    extraEnv:\n'
    for entry in username:smtp_config__auth__user password:smtp_config__auth__pass; do
      printf '      - name: %s\n        valueFrom:\n          secretKeyRef:\n            name: %s-smtp\n            key: %s\n' \
        "${entry#*:}" "$FULLNAME" "${entry%%:*}"
    done
  else
    # Every smtp_config__* key, not just the host: an smtp_config without a host fails with "No host specified in SMTP configuration".
    printf '    config:\n'
    for key in host port secure ignoreTLS requireTLS; do
      printf '      smtp_config__%s: null\n' "$key"
    done
  fi
  # No Postfix: outbound mail goes to SES through the instance's IAM role, inbound arrives from ses-bridge's Lambda,
  # which posts to the internal load balancer below (the public Gateway answers 404 for /internal).
  printf 'postfixBridge:\n  create: false\n'
  printf 'mail:\n  transport:\n    provider: ses\n'
  if [[ -n "$REGION" ]]; then
    printf '    ses:\n      region: %s\n' "`yamlQuote "$REGION"`"
  fi
  printf '  ingestService:\n    enabled: true\n'
  if [[ -n "$INGEST_CIDRS" ]]; then
    printf '    loadBalancerSourceRanges:\n'
    IFS=',' read -r -a ingestCidrs <<< "$INGEST_CIDRS"
    printf '      - %s\n' "${ingestCidrs[@]}"
  fi
} > "$VALUES_FILE"

if [[ -n "$SMTP_USERNAME" && -n "$SMTP_PASSWORD" ]]; then
  # The auth-server's SMTP account, in a Secret its pod reads (chart value authserver.service.extraEnv above). Written from
  # files, so neither value passes through this host's process list.
  kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
  smtpDir=`mktemp -d`
  chmod 700 "$smtpDir"
  printf '%s' "$SMTP_USERNAME" > "$smtpDir/username"
  printf '%s' "$SMTP_PASSWORD" > "$smtpDir/password"
  kubectl -n "$NAMESPACE" create secret generic "$FULLNAME-smtp" --from-file="$smtpDir/username" --from-file="$smtpDir/password" \
    --dry-run=client -o yaml | kubectl apply -f - >/dev/null
  smtpStatus=$?
  rm -rf "$smtpDir"
  [[ $smtpStatus -eq 0 ]] || fail "couldn't create the $FULLNAME-smtp Secret."
fi

GATEWAY_TLS=false
if [[ -n "$HTTPS_LISTENER" ]]; then
  GATEWAY_TLS=true
fi
log "Installing the RapidMX server chart..."
VERSION_ARGS=(--version "$CHART_VERSION")
if [[ -d "$CHART" ]]; then
  VERSION_ARGS=()
fi
OPENBAO_ARGS=(--set global.openbao.enabled=false)
if [[ "$OPENBAO" = "true" ]]; then
  OPENBAO_ARGS=(--set global.openbao.enabled=true
    --set global.openbao.address="$OPENBAO_ADDRESS"
    --set global.openbao.kvMount="$OPENBAO_KV_MOUNT"
    --set global.openbao.secretsPath="$OPENBAO_SECRETS_PATH"
    --set global.openbao.auth.method=token
    --set global.openbao.auth.tokenSecret="$OPENBAO_ESO_SECRET"
    --set openbao.pki.mount="$OPENBAO_PKI_MOUNT"
    --set openbao.pki.role="$OPENBAO_PKI_ROLE"
    --set openbao.pki.tokenSecret="$OPENBAO_PKI_SECRET")
fi
# The chart's bundled coturn (a TURN server for video calls) is left off here: it has to listen on the node's own address,
# which needs UDP open to the internet on an address that doesn't change, and this instance's public address is not fixed and
# the load balancer in front of the site can't carry UDP. See the README's "Video calls".
helm upgrade --install --create-namespace --namespace "$NAMESPACE" "$NAMESPACE" "$CHART" "${VERSION_ARGS[@]}" \
  --set global.domain="$DOMAIN" --set host="$SERVER_HOST" --set global.serverHost="$SERVER_HOST" --set authserver.host="$AUTH_HOST" \
  --set-json "global.corsHosts=[\"$SERVER_HOST\",\"$AUTH_HOST\"]" \
  --set global.certmanager.email="$ACME_EMAIL" \
  "${OPENBAO_ARGS[@]}" \
  --set global.gateway.tls="$GATEWAY_TLS" --set global.gateway.hsts=true \
  --set global.gateway.name="$GATEWAY_NAME" --set global.gateway.namespace="$GATEWAY_NAMESPACE" \
  --set coturn.create=false \
  -f "$VALUES_FILE" || fail "the RapidMX server chart failed to install."
rm -f "$VALUES_FILE"
VALUES_FILE=""

INGEST_LB=""
startTime=`date +%s`
while [[ $(( `date +%s` - startTime )) -lt 600 ]]; do
  INGEST_LB=`kubectl -n "$NAMESPACE" get svc "$FULLNAME-internal-ingest" -o jsonpath='{.status.loadBalancer.ingress[0].hostname}' 2>/dev/null`
  if [[ -n "$INGEST_LB" ]]; then
    break
  fi
  sleep 10
done

# --- Summary -------------------------------------------------------------------------------------
install -d -m 0700 "`dirname "$SUMMARY_FILE"`"
{
  echo "RapidMX server"
  echo "=============="
  echo
  echo "Address:            https://$SERVER_HOST (sign-in at https://$AUTH_HOST)"
  echo "Load balancer:      $LB_HOSTNAME"
  if [[ -z "$HOSTED_ZONE_ID" ]]; then
    echo "DNS:                point $SERVER_HOST and $AUTH_HOST at the load balancer (CNAME records)."
    echo "                    Certificates are issued once those records resolve."
  fi
  echo "Kubeconfig:         $K3S_KUBECONFIG (root only)"
  echo
  echo "Mail goes through SES. Deploy https://github.com/rapidmx/ses-bridge for $DOMAIN (and once more per extra mail"
  echo "domain), with its Lambda in this VPC so it can reach the ingest address below:"
  echo "  SES_BRIDGE_DOMAIN_NAME=$DOMAIN \\"
  echo "  MTA_INGEST_BASE_URL=http://${INGEST_LB:-<the $FULLNAME-internal-ingest load balancer>}/internal/mta \\"
  echo "  MTA_INGEST_SECRET=$INGEST_SECRET yarn deploy"
  echo "Then publish its DKIM records, point each mail domain's MX at SES, and activate its receipt rule set."
  if [[ -n "$SMTP_USERNAME" && -n "$SMTP_PASSWORD" ]]; then
    echo "The auth-server sends its sign-in codes from $MAIL_FROM through email-smtp.$REGION.amazonaws.com with the SMTP account"
    echo "in the $FULLNAME-smtp Secret; that address's domain must be a verified SES identity."
  else
    echo "The auth-server's e-mail (sign-in and verification codes) is NOT configured: it can only send over SMTP. Re-run with"
    echo "RAPIDMX_SES_SMTP_USERNAME and RAPIDMX_SES_SMTP_PASSWORD set to an SES SMTP account to turn it on."
  fi
  echo
  if [[ "$OPENBAO" = "true" ]]; then
    echo "Secrets live in OpenBao at $OPENBAO_KV_MOUNT/$OPENBAO_SECRETS_PATH, and External Secrets keeps them in the"
    echo "Kubernetes Secrets the pods read, so an upgrade doesn't have to pass any of them."
    if [[ "$OPENBAO_INSTALL" = "true" ]]; then
      echo "Back up the $OPENBAO_KEYS_SECRET Secret in namespace $OPENBAO_NAMESPACE: it holds the vault's unseal key and"
      echo "root token, and without it nothing in the vault can be recovered."
    fi
    echo "  mail ingest secret      $INGEST_SECRET"
  else
    echo "Secrets (keep them; an upgrade needs the same values):"
    echo "  global.jwt.secret       $AUTH_SECRET"
    echo "  global.mailIngestSecret $INGEST_SECRET"
  fi
} > "$SUMMARY_FILE"
chmod 600 "$SUMMARY_FILE"

log "Done. The summary, including the secrets, is in $SUMMARY_FILE."
# The same summary goes to the boot log, without the lines carrying a secret (the boot log is readable by anyone who
# can read the console output).
grep -v -e '^  global\.' -e '^  mail ingest secret' -e 'MTA_INGEST_SECRET=' "$SUMMARY_FILE"
echo "  (the secrets and the full ses-bridge command are in $SUMMARY_FILE)"
