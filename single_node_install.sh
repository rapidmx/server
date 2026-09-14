#!/usr/bin/env bash
# set -e
HOSTNAME=`hostname`
IS_WSL=false
DOMAIN="cluster.local"
TLS=true
VERSION="1.0.0-beta.2"
NAMESPACE="mail-server"
# The published chart: the CI pushes ./helm (chart name "server") to oci://ghcr.io/<owner>/charts.
CHART=${CHART:-oci://ghcr.io/rapidmx/charts/server}
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
# Markers around the block this script appends to nginx.conf, so a re-run replaces it instead of adding another.
NGINX_CONF=/etc/nginx/nginx.conf
NGINX_BEGIN="# BEGIN rapidmx single_node_install"
NGINX_END="# END rapidmx single_node_install"
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

# Single-quotes a value for YAML.
function yamlQuote() {
  local value=${1//\'/\'\'}
  printf "'%s'" "$value"
}

# The NodePort nginx-gateway-fabric's Service for shared-gateway exposes port $1 on, or nothing.
function gatewayNodePort() {
  kubectl -n nginx-gateway get svc -l gateway.networking.k8s.io/gateway-name=shared-gateway \
    -o jsonpath="{.items[0].spec.ports[?(@.port==$1)].nodePort}" 2>/dev/null
}

function uninstall() {
  if [[ -f "$NGINX_CONF.bak" ]]; then
    echo "Restoring nginx.conf..."
    sudo mv "$NGINX_CONF.bak" "$NGINX_CONF"
  fi
  echo "Removing nginx..."
  if [[ -e /etc/redhat-release ]]; then
    sudo dnf remove nginx -y
  else
    sudo apt-get remove nginx -y
  fi
  echo "Removing helm..."
  if command -v snap >/dev/null 2>&1; then
    sudo snap remove helm
  else
    echo "Unable to remove helm. Please uninstall manually."
  fi
  echo "Removing k3s..."
  sudo /usr/local/bin/k3s-uninstall.sh
  echo "Removing kubectl..."
  if command -v snap >/dev/null 2>&1; then
    sudo snap remove kubectl
  else
    echo "Unable to remove kubectl. Please uninstall manually."
  fi
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
          echo -e "\tk3s - Kubernetes distribution"
          echo -e "\tnginx - Nginx to handle proxying traffic"
          echo -e "\thelm - Helm to handle install/update software in k3s"
          echo -e "\tkubectl - Provide api interaction with k3s"

          echo "Usage:"
          echo -e "\t--domain <domain>\t\tThe domain name to use for the deployment of mail-server"
          echo -e "\t--version <version>\t\tThe version of mail-server to deploy"
          echo -e "\t--tls <true|false>\t\tInstalls cert manager and enables TLS ingress support (uses Let's Encrypt)"
          echo -e "\t--email <email>\t\tThe Let's Encrypt account email (default admin@<domain>)"
          echo -e "\t--skip-k3s\t\tSkips installation of k3s"
          echo -e "\t--uninstall\t\tUninstalls all installed items"
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

run_step "Installing kubectl"
if ! command -v kubectl &> /dev/null; then
    if command -v snap >/dev/null 2>&1; then
      sudo snap install --classic kubectl
    else
      curl -fLo /tmp/kubectl "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl" \
        && sudo install -m 0755 /tmp/kubectl /usr/local/bin/kubectl
      rm -f /tmp/kubectl
    fi
    if ! command -v kubectl &> /dev/null; then
      echo "There was a problem installing kubectl."
      exit 1
    fi
fi
if [[ "$KUBECONFIG" != "" ]]; then
  echo "KUBECONFIG currently defined as $KUBECONFIG, would you like to use this config or clear it?"
  select choice in "Use" "Clear"; do
    case $choice in
        Use ) break;;
        Clear ) unset KUBECONFIG; break;;
    esac
  done
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
  NEW_K3S=false
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
    curl -sfL https://get.k3s.io | INSTALL_K3S_EXEC="--flannel-backend=none --cluster-cidr=192.168.0.0/16 --disable-network-policy --disable=traefik" sh -
    if [ $? -ne 0 ]; then
      echo "There was a problem installing k3s."
      exit 1
    fi
    NEW_K3S=true
  fi
  if [[ -z "$KUBECONFIG" || "$KUBECONFIG" = "$K3S_KUBECONFIG" ]]; then
    installKubeconfig
    export KUBECONFIG="$USER_KUBECONFIG"
  fi

  if [[ "$NEW_K3S" = "true" ]]; then
    # Install Calico (calico must be installed before k3s nodes will be ready)
    echo "Installing calico..."
    kubectl create -f https://raw.githubusercontent.com/projectcalico/calico/v3.25.0/manifests/tigera-operator.yaml
    kubectl create -f https://raw.githubusercontent.com/projectcalico/calico/v3.25.0/manifests/custom-resources.yaml

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

    waitForDeployments calico-system calico
  fi
fi

# Install metrics-server
# run_step "Installing metrics server"
# kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml

# Install Helm
run_step "Installing helm"
if command -v helm >/dev/null 2>&1; then
  echo "helm is already installed."
else
  if command -v snap >/dev/null 2>&1; then
    sudo snap install --classic helm
  else
    curl https://raw.githubusercontent.com/helm/helm/master/scripts/get-helm-3 | sudo bash
  fi
  if ! command -v helm >/dev/null 2>&1; then
    echo "There was a problem installing helm."
    exit 1
  fi
fi

# Install nginx-gateway-fabric
run_step "Installing nginx-gateway-fabric"
kubectl apply -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.4.1/standard-install.yaml
kubectl kustomize "https://github.com/nginx/nginx-gateway-fabric/config/crd/gateway-api/standard?ref=v2.2.1" \
  | kubectl apply -f -
helm upgrade --install ngf oci://ghcr.io/nginx/charts/nginx-gateway-fabric --create-namespace -n nginx-gateway --set nginx.service.type=NodePort
waitForDeployments nginx-gateway nginx-gateway-fabric

# Configure a single shared Gateway. An HTTPS listener can only serve a host with a certificate, so it's added only when
# TLS is on and $DOMAIN can get one from Let's Encrypt (not localhost or *.local): it terminates TLS with the
# "$DOMAIN-tls-cert" Secret the mail-server chart's cert-manager Certificate creates in $NAMESPACE. The chart renders
# the ReferenceGrant that lets this Gateway (in nginx-gateway) use that Secret, because it's told the listener's name
# (gateway.httpsListener below). Without the listener the chart is installed with gateway.tls=false (plain HTTP).
HTTPS_LISTENER=""
if [[ "$TLS" = "true" && "$DOMAIN" != "localhost" && ! "$DOMAIN" =~ \.(local|localhost)$ ]]; then
  HTTPS_LISTENER="https"
fi
{
cat << EOF
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: shared-gateway
  namespace: nginx-gateway
spec:
  gatewayClassName: nginx
  listeners:
  - name: http
    protocol: HTTP
    port: 80
    allowedRoutes:
      namespaces:
        from: All
EOF
if [[ -n "$HTTPS_LISTENER" ]]; then
cat << EOF
  - name: $HTTPS_LISTENER
    protocol: HTTPS
    port: 443
    hostname: "$DOMAIN"
    tls:
      mode: Terminate
      certificateRefs:
      - kind: Secret
        name: $DOMAIN-tls-cert
        namespace: $NAMESPACE
    allowedRoutes:
      namespaces:
        from: All
EOF
fi
} | kubectl apply -f -

# Wait for nginx-gateway-fabric to provision the Gateway's NodePort Service, then read the ports bound to it.
HTTP_PORT=`gatewayNodePort 80`
HTTPS_PORT=`gatewayNodePort 443`
startTime=`date +%s`
while [[ ( -z "$HTTP_PORT" || ( -n "$HTTPS_LISTENER" && -z "$HTTPS_PORT" ) ) && $(( `date +%s` - startTime )) -lt 1800 ]]; do
  sleep 2
  echo "Waiting for shared-gateway to be ready..."
  HTTP_PORT=`gatewayNodePort 80`
  HTTPS_PORT=`gatewayNodePort 443`
done
if [[ -z "$HTTP_PORT" || ( -n "$HTTPS_LISTENER" && -z "$HTTPS_PORT" ) ]]; then
  echo "There was a problem setting up the shared-gateway..."
  exit 1
fi

# Set up nginx reverse proxy
run_step "Installing nginx reverse proxy"
if [[ -e /etc/redhat-release ]]; then
  if ! rpm -q nginx >/dev/null 2>&1; then
    echo "Installing nginx for reverse proxy..."
    sudo dnf install nginx nginx-mod-stream -y
    if [ $? -ne 0 ]; then
      echo "There was a problem installing nginx reverse proxy."
      exit 1
    fi
  fi
else
  if ! dpkg -s nginx >/dev/null 2>&1; then
    echo "Installing nginx for reverse proxy..."
    sudo apt-get install nginx libnginx-mod-stream -y
    if [ $? -ne 0 ]; then
      echo "There was a problem installing nginx reverse proxy."
      exit 1
    fi
  fi
fi
if ! sudo grep -qxF "$NGINX_BEGIN" "$NGINX_CONF" && sudo grep -Eq '^[[:space:]]*stream[[:space:]]*\{' "$NGINX_CONF"; then
  # Written by an earlier version of this script (without markers) or by hand: don't add a second stream block.
  echo "$NGINX_CONF already has a stream {} block this script didn't write; make sure it forwards port 80 to" \
    "127.0.0.1:$HTTP_PORT${HTTPS_PORT:+ and port 443 to 127.0.0.1:$HTTPS_PORT}, then re-run."
else
  if [[ ! -f "$NGINX_CONF.bak" ]]; then
    echo "Backing up nginx.conf..."
    sudo cp "$NGINX_CONF" "$NGINX_CONF.bak"
  fi
  echo "Writing nginx configuration..."
  # Port 443 is only forwarded when the Gateway has an HTTPS listener (see HTTPS_LISTENER above).
  HTTPS_SERVER=""
  if [[ -n "$HTTPS_PORT" ]]; then
    HTTPS_SERVER="
    server {
        listen 443;
        proxy_pass 127.0.0.1:$HTTPS_PORT;
    }"
  fi
  # Replace the block from an earlier run (the Gateway's NodePorts may have changed).
  sudo sed -i "/^$NGINX_BEGIN\$/,/^$NGINX_END\$/d" "$NGINX_CONF"
  sudo tee -a "$NGINX_CONF" > /dev/null << EOF
$NGINX_BEGIN
stream {
    server {
        listen 80;
        proxy_pass 127.0.0.1:$HTTP_PORT;
    }$HTTPS_SERVER
}
$NGINX_END
EOF
  if [[ -f /etc/nginx/sites-enabled/default ]]; then
    sudo rm /etc/nginx/sites-enabled/default
  fi
  sudo systemctl restart nginx
  if [ $? -ne 0 ]; then
    echo "There was a problem restarting nginx reverse proxy."
    exit 1
  fi
  NGINX_READY=0
  startTime=`date +%s`
  while [[ $(( `date +%s` - startTime )) -lt 300 ]]; do
    # Any HTTP answer (even a 404 before the chart's routes exist) means the proxy is forwarding to the Gateway.
    if curl -s -o /dev/null http://localhost; then
      NGINX_READY=1
      break
    fi
    echo "Waiting for nginx to start..."
    sleep 2
  done
  if [ $NGINX_READY -eq 0 ]; then
    echo "There was a problem configuring nginx reverse proxy."
    exit 1
  fi
fi
echo "Reverse proxy is setup."

if [[ "$TLS" = "true" ]]; then
  # Install cert-manager
  run_step "Installing cert-manager"

  helm upgrade --install cert-manager oci://quay.io/jetstack/charts/cert-manager --namespace cert-manager --create-namespace \
    --set config.apiVersion="controller.config.cert-manager.io/v1alpha1" \
    --set config.kind="ControllerConfiguration" \
    --set config.enableGatewayAPI=true \
    --set installCRDs=true
  waitForDeployments cert-manager cert-manager

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
            - name: shared-gateway
              namespace: nginx-gateway
              kind: Gateway
EOF
  do
    if [[ $(( `date +%s` - startTime )) -ge 300 ]]; then
      echo "There was a problem creating the letsencrypt-prod ClusterIssuer..."
      exit 1
    fi
    sleep 5
  done
fi

run_step "Installing mail-server"
# Add Bitnami helm repo
addHelmRepo bitnami https://charts.bitnami.com/bitnami
helm repo up

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
helm upgrade --install --create-namespace --namespace "$NAMESPACE" "$NAMESPACE" "$CHART" \
  --version "$VERSION" --set host="$DOMAIN" --set gateway.tls="$GATEWAY_TLS" --set gateway.hsts="$TLS" \
  --set gateway.name=shared-gateway --set gateway.namespace=nginx-gateway --set gateway.httpsListener="$HTTPS_LISTENER" \
  -f "$VALUES_FILE"
if [ $? -ne 0 ]; then
  echo "There was a problem installing mail-server."
  exit 1
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
fi
