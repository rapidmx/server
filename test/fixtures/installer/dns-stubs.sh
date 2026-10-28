# Stubs the DNS installer tests (test/installer/dns.test.ts) source after stubs.sh. They replace kubectl, curl and ip with functions that record
# their arguments in $WORK/<name>.log and answer from files in $WORK, which stand for the cluster's and the network's state:
#   state               what the installer recorded as installed, one key=value per line (the installer's own recordInstalled and installedBy,
#                       which dns() points at it with STATE_DIR and STATE_FILE)
#   crd                 exists while the DNSEndpoint CRD is in the cluster
#   server.log          what the server pods logged; server-new.log, when it exists, is what they logged since the --since-time a read gives, and
#                       server-after-restart.log replaces it when the Deployment is restarted
#   rows                the release's DNSEndpoints as the installer asks to list them: name|domain|dnsName=TYPE dnsName=TYPE ...
#   all-endpoints       every DNSEndpoint in the cluster, one name per line
#   deployment-<name>   exists while that Deployment does
#   secret-<name>       exists while that Secret does
#   release             exists while the Helm release is installed; helm-values.json is what `helm get values -o json` answers for it
#   ip.out              what `ip -o addr show scope global` prints
#   cloudflare.json     what Cloudflare's API answers (cloudflare-<zone>.json for the lookup of one zone); curl-v4 / curl-v6: what the address services answer
# ROLLOUT_EXIT, CRD_WAIT_EXIT and KUBE_DOWN make the matching calls fail.
ip() { echo "$*" >> "$WORK/ip.log"; cat "$WORK/ip.out" 2>/dev/null; return 0; }
curl() {
  echo "$*" >> "$WORK/curl.log"
  local config=""
  case "$*" in
    *" -K -"*|*"-K - "*|*" -K -") config=$(cat);;
  esac
  case "$*" in
    *api.cloudflare.com*)
      # The request's configuration (the Authorization header) came over stdin, never in an argument.
      [ -z "$config" ] || echo "$config" >> "$WORK/cloudflare-config.log"
      # cloudflare-<zone>.json answers the lookup of that zone, cloudflare.json every other.
      local zone; zone=$(printf '%s' "$*" | sed -n 's/.*zones?name=\([^& "]*\).*/\1/p')
      echo "$zone" >> "$WORK/cloudflare-zones.log"
      if [ -f "$WORK/cloudflare-$zone.json" ]; then cat "$WORK/cloudflare-$zone.json"; return 0; fi
      [ -f "$WORK/cloudflare.json" ] || return 22
      cat "$WORK/cloudflare.json";;
    *ipify*)
      case "$*" in
        *" -6 "*|*api6*) [ -f "$WORK/curl-v6" ] || return 7; cat "$WORK/curl-v6";;
        *) [ -f "$WORK/curl-v4" ] || return 7; cat "$WORK/curl-v4";;
      esac;;
    *) return 6;;
  esac
}
helm() {
  echo "$*" >> "$WORK/helm.log"
  case "$*" in
    "status "*) [ -f "$WORK/release" ];;
    "get values "*) [ -f "$WORK/release" ] && cat "$WORK/helm-values.json" 2>/dev/null; return 0;;
  esac
}
kubectl() {
  echo "$*" >> "$WORK/kubectl.log"
  local name
  case "$*" in
    *"get nodes"*) return "${KUBE_DOWN:-0}";;
    *"get crd"*) [ -f "$WORK/crd" ];;
    *"apply --server-side"*)
      local n; n=$(ls "$WORK" | grep -c '^crd-applied'); cat > "$WORK/crd-applied-$n.yaml"; touch "$WORK/crd";;
    *"wait --for=condition=Established"*) return "${CRD_WAIT_EXIT:-0}";;
    *"--dry-run=client -o yaml"*) echo "kind: Namespace";;
    *"apply -f -"*) local n; n=$(ls "$WORK" | grep -c '^applied'); cat > "$WORK/applied-$n.yaml";;
    *"rollout status"*) return "${ROLLOUT_EXIT:-0}";;
    *"rollout restart"*) [ -f "$WORK/server-after-restart.log" ] && cp "$WORK/server-after-restart.log" "$WORK/server-new.log"; return 0;;
    *" logs "*)
      case "$*" in
        *--since-time=*) if [ -f "$WORK/server-new.log" ]; then cat "$WORK/server-new.log"; return 0; fi;;
      esac
      cat "$WORK/server.log" 2>/dev/null; return 0;;
    *"get dnsendpoints"*" -A "*|*"get dnsendpoints -A"*) cat "$WORK/all-endpoints" 2>/dev/null; return 0;;
    *"get dnsendpoints"*) cat "$WORK/rows" 2>/dev/null; return 0;;
    *"get deployment"*)
      name=$(printf '%s\n' "$@" | awk 'prev == "deployment" { print; exit } { prev = $0 }')
      [ -f "$WORK/deployment-$name" ];;
    *"get secret"*)
      name=$(printf '%s\n' "$@" | awk 'prev == "secret" { print; exit } { prev = $0 }')
      [ -f "$WORK/secret-$name" ];;
    *) return 0;;
  esac
}
