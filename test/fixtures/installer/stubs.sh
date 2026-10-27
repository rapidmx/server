# Stubs the installer tests (test/installer/openbao.test.ts) source before an installer's functions. Each records its
# arguments, one call per line, in $WORK/<name>.log; the files in $WORK stand for the cluster's state.
log() { echo "$*"; }
sudo() { "$@"; }
recordInstalled() { :; }
sleep() { :; }
helm() { echo "$*" >> "$WORK/helm.log"; }
openssl() {
  echo "$*" >> "$WORK/openssl.log"
  case "$*" in
    *s_client*) printf '%s' "$SERVED_CERT";;
    *x509*) local cert; cert=$(cat); [ -n "$cert" ] && echo "notAfter=$cert";;
  esac
}
kubectl() {
  echo "$*" >> "$WORK/kubectl.log"
  case "$*" in
    *"exec -i"*"sh -s"*)
      local n; n=$(ls "$WORK" | grep -c '^pod-script'); cat > "$WORK/pod-script-$n.sh"; return "${POD_EXIT:-0}";;
    *"wait --for=condition=Ready secretstore"*) return "${STORES_READY:-0}";;
    *"create token"*)
      [ "${CREATE_TOKEN_EXIT:-0}" = 0 ] || return 1
      local account; account=$(printf '%s\n' "$@" | awk 'prev == "token" { print; exit } { prev = $0 }')
      echo "eyJ.$account.sig";;
    *"wait --for=condition=Ready certificate"*) return 0;;
    *"get secret"*)
      local name; name=$(printf '%s\n' "$@" | awk 'prev == "secret" { print; exit } { prev = $0 }')
      [ -f "$WORK/secret-$name" ] || return 1
      case "$*" in *jsonpath*) cat "$WORK/secret-$name";; esac;;
    *"get statefulset"*"updateRevision"*) printf '%s' "$UPDATE_REVISION";;
    *"get statefulset"*"observedGeneration"*) printf '1';;
    *"get statefulset"*"metadata.generation"*) printf '1';;
    *"get pod"*"controller-revision-hash"*) printf '%s' "$POD_REVISION";;
    *"port-forward"*) :;;
    *"--dry-run=client -o yaml"*) echo "kind: Namespace";;
    *"apply -f -"*) local n; n=$(ls "$WORK" | grep -c '^applied'); cat > "$WORK/applied-$n.yaml";;
  esac
}
