#!/usr/bin/env bash
# set -e
IS_WSL=false
DOMAIN="cluster.local"
TLS=true
VERSION="1.0.0-beta.3"
NAMESPACE="rapidmx-server"
# The published chart: the CI pushes ./helm (chart name "server") to oci://ghcr.io/<owner>/charts. Set CHART to a local
# chart directory (e.g. CHART=./helm) to install from a checkout instead; --version is then ignored.
CHART=${CHART:-oci://ghcr.io/rapidmx/charts/server}
# Envoy Gateway release (https://github.com/envoyproxy/gateway/releases). Pinned: v0.0.0-latest tracks main.
ENVOY_GATEWAY_VERSION=${ENVOY_GATEWAY_VERSION:-v1.9.1}
GATEWAY_NAMESPACE=envoy-gateway-system
GATEWAY_NAME=shared-gateway
# Let's Encrypt account email for the ClusterIssuer. Defaults to admin@<domain> (a bare host name isn't a valid domain).
ACME_EMAIL=${ACME_EMAIL:-}
UNINSTALL=false
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
NGINX_BEGIN="# BEGIN rapidmx-server"
NGINX_END="# END rapidmx-server"
# Prefix of the nginx.conf lines this script commented out (http server blocks listening on port 80); --uninstall
# restores them.
NGINX_DISABLED_PREFIX="#rapidmx-server# "
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
total_steps=7
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

# Single-quotes a value for YAML.
function yamlQuote() {
  local value=${1//\'/\'\'}
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

# Opens port $1 (e.g. 80/tcp) in the active firewall, unless already open, recording the rule for --uninstall.
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
      if ufwAllow "$1"; then
        recordFirewallRule ufw allow "$1"
      fi
      ;;
  esac
}

# Reads field $1 (a jsonpath) of the Service Envoy Gateway created for the shared Gateway.
function gatewayService() {
  kubectl -n "$GATEWAY_NAMESPACE" get svc -o jsonpath="{.items[0]$1}" 2>/dev/null \
    -l "gateway.envoyproxy.io/owning-gateway-name=$GATEWAY_NAME,gateway.envoyproxy.io/owning-gateway-namespace=$GATEWAY_NAMESPACE"
}

function uninstall() {
  if [[ -z "$KUBECONFIG" && -f "$USER_KUBECONFIG" ]]; then
    export KUBECONFIG="$USER_KUBECONFIG"
  fi
  if ! sudo test -f "$STATE_FILE"; then
    echo "$STATE_FILE doesn't exist, so there is no record of what this script installed (or an earlier version of it"
    echo "did the install). Only this script's nginx configuration is removed; remove k3s, helm and nginx manually if"
    echo "this script installed them."
  fi
  if [[ "`installedBy k3s`" = "true" ]]; then
    # Removes the whole cluster, with everything this script installed into it.
    echo "Removing k3s..."
    sudo /usr/local/bin/k3s-uninstall.sh
  else
    local release
    release=`installedBy release`
    if [[ -n "$release" ]]; then
      echo "Removing the RapidMX server release (including its data volumes)..."
      helm uninstall "$release" -n "$release"
    fi
    if [[ "`installedBy cluster_issuer`" = "true" ]]; then
      echo "Removing the letsencrypt-prod ClusterIssuer..."
      kubectl delete clusterissuer letsencrypt-prod --ignore-not-found
    fi
    if [[ "`installedBy cert_manager`" = "true" ]]; then
      echo "Removing cert-manager..."
      helm uninstall cert-manager -n cert-manager
    fi
    if [[ "`installedBy shared_gateway`" = "true" ]]; then
      echo "Removing $GATEWAY_NAME..."
      kubectl -n "$GATEWAY_NAMESPACE" delete clienttrafficpolicy "$GATEWAY_NAME-proxy-protocol" --ignore-not-found
      kubectl -n "$GATEWAY_NAMESPACE" delete gateway "$GATEWAY_NAME" --ignore-not-found
    fi
    if [[ "`installedBy envoy_gateway_class`" = "true" ]]; then
      echo "Removing the envoy GatewayClass..."
      kubectl delete gatewayclass envoy --ignore-not-found
      kubectl -n "$GATEWAY_NAMESPACE" delete envoyproxy bare-metal-proxy --ignore-not-found
    fi
    if [[ "`installedBy envoy_gateway`" = "true" ]]; then
      echo "Removing envoy-gateway..."
      helm uninstall eg -n "$GATEWAY_NAMESPACE"
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

GETOPT=$(getopt -o h --long domain:,version:,tls:,email:,uninstall,install-cert-manager,skip-k3s,help -- "$@")
if [ $? -ne 0 ]; then
  exit 1
fi
eval set -- "$GETOPT"
while true
do
    case "$1" in
        --domain) DOMAIN=$2; shift 2;;
        --version) VERSION=$2; shift 2;;
        --tls) TLS=$2; shift 2;;
        --email) ACME_EMAIL=$2; shift 2;;
        --skip-k3s) SKIP_K3S=true; shift;;
        --uninstall) UNINSTALL=true; shift;;
        --install-cert-manager) TLS=true; shift;;
        -h | --help)
          echo "This scripts sets up a complete single-node k3s (Kubernetes) cluster. No arguments will do an install"
          echo "During install this will install the following:"
          echo -e "\tk3s - Kubernetes distribution (includes kubectl)"
          echo -e "\thelm - Helm to handle install/update software in k3s"
          echo -e "\tenvoy-gateway - Gateway API implementation routing traffic to the services"
          echo -e "\tnginx - Nginx to forward ports 80 and 443 to envoy-gateway"
          echo -e "\tcert-manager - Let's Encrypt certificates (with --tls true)"

          echo "Usage:"
          echo -e "\t--domain <domain>\t\tThe domain name to use for the deployment of mail-server"
          echo -e "\t--version <version>\t\tThe version of mail-server to deploy"
          echo -e "\t--tls <true|false>\t\tInstalls cert manager and enables TLS ingress support (uses Let's Encrypt)"
          echo -e "\t--email <email>\t\tThe Let's Encrypt account email (default admin@<domain>)"
          echo -e "\t--skip-k3s\t\tSkips installation of k3s"
          echo -e "\t--uninstall\t\tUninstalls what this script installed (recorded in $STATE_FILE)"
          echo "Environment:"
          echo -e "\tCHART\t\t\tThe chart to install (default $CHART), e.g. ./helm for a local checkout"
          echo -e "\tENVOY_GATEWAY_VERSION\tThe envoy-gateway release to install (default $ENVOY_GATEWAY_VERSION)"
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
ACME_EMAIL=${ACME_EMAIL:-admin@$DOMAIN}
if [[ "$TLS" = "false" ]]; then
  # No cert-manager step.
  total_steps=$(( total_steps - 1 ))
fi

if [[ "$UNINSTALL" = "true" ]]; then
  uninstall
  exit 0
fi

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
    curl -sfL https://get.k3s.io | INSTALL_K3S_EXEC="$K3S_OPTIONS" sh -
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
    curl https://raw.githubusercontent.com/helm/helm/master/scripts/get-helm-3 | sudo bash
    HELM_INSTALLED_BY=script
  fi
  if ! command -v helm >/dev/null 2>&1; then
    echo "There was a problem installing helm."
    exit 1
  fi
  recordInstalled helm "$HELM_INSTALLED_BY"
fi

# Install envoy gateway
run_step "Installing envoy-gateway"
if helm status eg -n "$GATEWAY_NAMESPACE" >/dev/null 2>&1; then
  # Not upgraded here: helm doesn't upgrade CRDs, see https://gateway.envoyproxy.io/docs/install/install-helm/.
  echo "envoy-gateway is already installed."
elif helm install eg oci://docker.io/envoyproxy/gateway-helm --version "$ENVOY_GATEWAY_VERSION" \
    -n "$GATEWAY_NAMESPACE" --create-namespace; then
  recordInstalled envoy_gateway
else
  echo "There was a problem installing envoy-gateway..."
  exit 1
fi
echo "Checking envoy-gateway has started..."
if ! kubectl wait --timeout=5m -n "$GATEWAY_NAMESPACE" deployment/envoy-gateway --for=condition=Available; then
  echo "There was a problem installing envoy-gateway..."
  exit 1
fi
echo "envoy-gateway is running!"

# The Gateway's Envoy Service is a ClusterIP: only this host's nginx (below) forwards to it, using the PROXY protocol so
# Envoy puts each client's real address in X-Forwarded-For (the server's rate limits and audit log use it). A NodePort
# would expose Envoy on every interface, where anyone could send a PROXY header claiming any address.
if ! kubectl get gatewayclass envoy >/dev/null 2>&1; then
  ENVOY_GATEWAY_CLASS_NEW=true
fi
if ! kubectl apply -f - << EOF
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: EnvoyProxy
metadata:
  name: bare-metal-proxy
  namespace: $GATEWAY_NAMESPACE
spec:
  provider:
    type: Kubernetes
    kubernetes:
      envoyService:
        type: ClusterIP
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
    name: bare-metal-proxy
    namespace: $GATEWAY_NAMESPACE
EOF
then
  echo "There was a problem configuring the envoy GatewayClass..."
  exit 1
fi
if [[ "$ENVOY_GATEWAY_CLASS_NEW" = "true" ]]; then
  recordInstalled envoy_gateway_class
fi

# Configure a single shared Gateway. An HTTPS listener can only serve a host with a certificate, so HTTPS listeners are
# added only when TLS is on and $DOMAIN can get one from Let's Encrypt (not localhost or *.local): "https" for $DOMAIN
# and "https-auth" for the auth-server's auth.$DOMAIN, terminating TLS with the "<host>-tls-cert" Secrets that the chart
# and its auth-server subchart have cert-manager issue in $NAMESPACE. The chart renders the ReferenceGrant that lets this
# Gateway use them, because it's told the listener names (gateway.httpsListener and gateway.authHttpsListener below).
# Without them the chart is installed with gateway.tls=false (plain HTTP).
AUTH_DOMAIN="auth.$DOMAIN"
HTTPS_LISTENER=""
AUTH_HTTPS_LISTENER=""
if [[ "$TLS" = "true" && "$DOMAIN" != "localhost" && ! "$DOMAIN" =~ \.(local|localhost)$ ]]; then
  HTTPS_LISTENER="https"
  # The auth-server subchart only issues a certificate for a host that doesn't contain ".local".
  if [[ "$AUTH_DOMAIN" != *.local* ]]; then
    AUTH_HTTPS_LISTENER="https-auth"
  fi
fi
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
  gatewayClassName: envoy
  listeners:
  - allowedRoutes:
      namespaces:
        from: All
    name: http
    port: 80
    protocol: HTTP
EOF
for listener in "$HTTPS_LISTENER:$DOMAIN" "$AUTH_HTTPS_LISTENER:$AUTH_DOMAIN"; do
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

# Wait for envoy-gateway to provision the Gateway's Service (with port 443 once there's an HTTPS listener).
echo "Waiting for $GATEWAY_NAME's Envoy Service..."
GATEWAY_IP=""
startTime=`date +%s`
while [[ $(( `date +%s` - startTime )) -lt 300 ]]; do
  GATEWAY_IP=`gatewayService .spec.clusterIP`
  GATEWAY_TYPE=`gatewayService .spec.type`
  GATEWAY_HTTPS_PORT=`gatewayService '.spec.ports[?(@.port==443)].port'`
  if [[ -n "$GATEWAY_IP" && "$GATEWAY_TYPE" = "ClusterIP" && ( -z "$HTTPS_LISTENER" || -n "$GATEWAY_HTTPS_PORT" ) ]]; then
    break
  fi
  GATEWAY_IP=""
  sleep 2
done
if [[ -z "$GATEWAY_IP" ]]; then
  echo "There was a problem setting up $GATEWAY_NAME: its Envoy Service isn't a ClusterIP Service with port 80${HTTPS_LISTENER:+ and 443}."
  if [[ "$GATEWAY_TYPE" = "NodePort" ]]; then
    echo "An earlier version of this script made it a NodePort Service. Delete it (envoy-gateway recreates it) and re-run:"
    echo "  kubectl -n $GATEWAY_NAMESPACE delete svc -l gateway.envoyproxy.io/owning-gateway-name=$GATEWAY_NAME"
  fi
  exit 1
fi
GATEWAY_ADDRESS=$GATEWAY_IP
if [[ "$GATEWAY_IP" = *:* ]]; then
  GATEWAY_ADDRESS="[$GATEWAY_IP]"
fi

# Set up nginx reverse proxy
run_step "Installing nginx reverse proxy"
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
  echo "Opening HTTP${HTTPS_LISTENER:+ and HTTPS} in `activeFirewall`..."
  firewallOpenPort 80/tcp
  if [[ -n "$HTTPS_LISTENER" ]]; then
    firewallOpenPort 443/tcp
  fi
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
    "$GATEWAY_ADDRESS:80${HTTPS_LISTENER:+ and port 443 to $GATEWAY_ADDRESS:443} with proxy_protocol on, then re-run."
else
  if [[ ! -f "$NGINX_CONF.bak" ]]; then
    echo "Backing up nginx.conf..."
    sudo cp "$NGINX_CONF" "$NGINX_CONF.bak"
  fi
  echo "Writing nginx configuration..."
  # The stream proxy takes port 80 (and 443) for the Gateway, so no http server may listen there.
  disablePort80HttpServers
  # Port 443 is only forwarded when the Gateway has an HTTPS listener (see HTTPS_LISTENER above).
  HTTPS_SERVER=""
  if [[ -n "$HTTPS_LISTENER" ]]; then
    HTTPS_SERVER="
    server {
        listen 443;
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
        listen 80;
        proxy_pass $GATEWAY_ADDRESS:80;
        proxy_protocol on;
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
echo "Checking the reverse proxy reaches $GATEWAY_NAME..."
result=000
startTime=`date +%s`
while [[ $(( `date +%s` - startTime )) -lt 300 ]]; do
  # Any HTTP answer (a 404 before the chart's routes exist) means nginx reaches Envoy and Envoy accepts its PROXY header.
  result=`curl -s -o /dev/null -w "%{http_code}" http://localhost`
  if [[ "$result" != "000" ]]; then
    break
  fi
  echo "Waiting for the reverse proxy..."
  sleep 2
done
if [[ "$result" = "000" ]]; then
  echo "There was a problem configuring nginx reverse proxy: http://localhost doesn't answer. Check the Envoy pods with"
  echo "  kubectl -n $GATEWAY_NAMESPACE get pods -l gateway.envoyproxy.io/owning-gateway-name=$GATEWAY_NAME"
  exit 1
fi
echo "Reverse proxy is setup."

if [[ "$TLS" = "true" ]]; then
  # Install cert-manager
  run_step "Installing cert-manager"

  if ! helm status cert-manager -n cert-manager >/dev/null 2>&1; then
    CERT_MANAGER_NEW=true
  fi
  helm upgrade --install cert-manager oci://quay.io/jetstack/charts/cert-manager --namespace cert-manager --create-namespace \
        --set config.apiVersion="controller.config.cert-manager.io/v1alpha1" \
        --set config.kind="ControllerConfiguration" \
        --set config.enableGatewayAPI=true \
        --set crds.enabled=true
  waitForDeployments cert-manager cert-manager
  if [[ "$CERT_MANAGER_NEW" = "true" ]]; then
    recordInstalled cert_manager
  fi

  if ! kubectl get clusterissuer letsencrypt-prod >/dev/null 2>&1; then
    CLUSTER_ISSUER_NEW=true
  fi
  # The webhook can take a moment to accept requests after its Deployment is Available.
  startTime=`date +%s`
  until cat << EOF | kubectl apply -f -
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: $ACME_EMAIL
    privateKeySecretRef:
      name: letsencrypt-issuer-key
    solvers:
    - http01:
        gatewayHTTPRoute:
          parentRefs:
          - group: gateway.networking.k8s.io
            kind: Gateway
            name: $GATEWAY_NAME
            namespace: $GATEWAY_NAMESPACE
EOF
  do
    if [[ $(( `date +%s` - startTime )) -ge 300 ]]; then
      echo "There was a problem creating the letsencrypt-prod ClusterIssuer..."
      exit 1
    fi
    sleep 5
  done
  if [[ "$CLUSTER_ISSUER_NEW" = "true" ]]; then
    recordInstalled cluster_issuer
  fi
fi

run_step "Installing RapidMX server"
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

# The chart requires the JWT secret (shared with auth-server) and the postfix-bridge ingest secret. Reuse the ones from
# an existing install, so re-running this script doesn't rotate them; otherwise generate new ones.
function existingSecret() {
  for name in "$NAMESPACE-$1" "$NAMESPACE-server-$1"; do
    value=`kubectl -n "$NAMESPACE" get secret "$name" -o jsonpath="{.data.$2}" 2>/dev/null | base64 -d 2>/dev/null`
    if [[ -n "$value" ]]; then
      echo "$value"
      return
    fi
  done
}
AUTH_SECRET=${AUTH_SECRET:-`existingSecret jwt-auth auth__secret`}
AUTH_SECRET=${AUTH_SECRET:-`openssl rand -hex 32`}
MAIL_INGEST_SECRET=${MAIL_INGEST_SECRET:-`existingSecret mail-ingest-secret mail__transport__ingest__secret`}
MAIL_INGEST_SECRET=${MAIL_INGEST_SECRET:-`openssl rand -hex 32`}

# Secrets go to helm in a values file only this user can read (deleted on exit), never on the command line, where any
# local user could read them from the process list.
VALUES_FILE=`mktemp "${TMPDIR:-/tmp}/mail-server-values.XXXXXX"`
chmod 600 "$VALUES_FILE"
{
  printf 'global:\n  authSecret: %s\n' "`yamlQuote "$AUTH_SECRET"`"
  printf 'mail:\n  ingestSecret: %s\n' "`yamlQuote "$MAIL_INGEST_SECRET"`"
} > "$VALUES_FILE"

# gateway.tls only when the Gateway has an HTTPS listener for $DOMAIN: the chart refuses TLS on a Gateway it doesn't own
# without one.
GATEWAY_TLS=false
if [[ -n "$HTTPS_LISTENER" ]]; then
  GATEWAY_TLS=true
fi
if ! helm status "$NAMESPACE" -n "$NAMESPACE" >/dev/null 2>&1; then
  RELEASE_NEW=true
fi
# Sign-in redirects browsers to authServer.host, and the auth-server subchart attaches its own HTTPRoute to
# authServer.gateway.*, so both follow the shared Gateway too. gateway.hsts stays true (browsers ignore HSTS over plain
# HTTP anyway): false renders a response header filter chart versions up to 1.0.0-beta.2 wrote for nginx-gateway only.
if ! helm upgrade --install --create-namespace --namespace "$NAMESPACE" "$NAMESPACE" "$CHART" "${CHART_VERSION_ARGS[@]}" \
  --set host="$DOMAIN" --set gateway.tls="$GATEWAY_TLS" --set gateway.hsts=true \
  --set gateway.name="$GATEWAY_NAME" --set gateway.namespace="$GATEWAY_NAMESPACE" \
  --set gateway.httpsListener="$HTTPS_LISTENER" --set gateway.authHttpsListener="$AUTH_HTTPS_LISTENER" \
  --set authServer.host="$AUTH_DOMAIN" --set authServer.gateway.tls="$GATEWAY_TLS" \
  --set authServer.gateway.name="$GATEWAY_NAME" --set authServer.gateway.namespace="$GATEWAY_NAMESPACE" \
  -f "$VALUES_FILE"; then
  echo "There was a problem installing the RapidMX server."
  exit 1
fi
if [[ "$RELEASE_NEW" = "true" ]]; then
  recordInstalled release "$NAMESPACE"
fi
rm -f "$VALUES_FILE"
VALUES_FILE=""

# Stop background loop
running=false
if [[ -n "$progress_pid" ]]; then
  wait "$progress_pid"
fi

# The chart's resource prefix (its "rrst.fullname"): the release name, suffixed with the chart name "server" unless the
# release name already contains it.
FULLNAME=$NAMESPACE
if [[ "$NAMESPACE" != *server* ]]; then
  FULLNAME="$NAMESPACE-server"
fi
echo "Installation complete."
echo "postfix-bridge must be installed with mail.ingestSecret set to this release's ingest secret. Read it with:"
echo "  kubectl -n $NAMESPACE get secret $FULLNAME-mail-ingest-secret -o jsonpath='{.data.mail__transport__ingest__secret}' | base64 -d"
echo "Keep the JWT secret for upgrades (pass it as global.authSecret):"
echo "  kubectl -n $NAMESPACE get secret $FULLNAME-jwt-auth -o jsonpath='{.data.auth__secret}' | base64 -d"

if [[ $DOMAIN =~ \.local(host)?$ || $DOMAIN = "localhost" ]]; then
  echo "Please update the hosts file to resolve the following:"
  echo -e "\t $DOMAIN"
  echo -e "\t $AUTH_DOMAIN"
fi
