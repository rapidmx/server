{{/* vim: set filetype=mustache: */}}
{{/*
Expand the name of the chart.
*/}}
{{- define "rrst.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Create a default fully qualified app name.
We truncate at 63 chars because some Kubernetes name fields are limited to this (by the DNS naming spec).
If release name contains chart name it will be used as a full name.
*/}}
{{- define "rrst.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/*
Create chart name and version as used by the chart label.
*/}}
{{- define "rrst.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Common labels
*/}}
{{- define "rrst.labels" -}}
app.kubernetes.io/name: {{ include "rrst.name" . }}
helm.sh/chart: {{ include "rrst.chart" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{/*
Renders a value that contains template.
Usage:
{{ include "rrst.render" ( dict "value" .Values.path.to.the.Value "context" $) }}
*/}}
{{- define "rrst.render" -}}
    {{- if typeIs "string" .value }}
        {{- tpl .value .context }}
    {{- else }}
        {{- tpl (.value | toYaml) .context }}
    {{- end }}
{{- end -}}

{{/*
Generate certificates for nginx
*/}}
{{- define "rrst.gen-nginx-certs" -}}
{{- $ca := genCA "xbe-ca" 365 -}}
{{- $cert := genSignedCert . nil nil 365 $ca -}}
tls.crt: {{ $cert.Cert | b64enc }}
tls.key: {{ $cert.Key | b64enc }}
{{- end -}}

{{/*
Generate list of domains with subdomain and/or path
*/}}
{{- define "rrst.domains" -}}
{{- $Values := .Values }}
{{- $SubDomain := "" }}
{{- if and .system (hasKey .system "host_subdomain") }}
    {{- $SubDomain = .system.host_subdomain }}
{{- end -}}
{{- $Path := "" }}
{{- if .path }}
    {{- $Path = .path }}
{{- end -}}
{{- $Protocol := "" }}
{{- if .protocol }}
    {{- $Protocol = .protocol }}
{{- end -}}
{{- $NewDomains := list  }}
{{- $CurrentDomains := list $Values.domain }}
{{- if and (hasKey $Values "alias_domains") (kindIs "slice" $Values.alias_domains)}}
{{- $CurrentDomains = concat $CurrentDomains $Values.alias_domains -}}
{{- end -}}
{{- range $domain := $CurrentDomains -}}
    {{- if $SubDomain }}
    {{- $domain = printf "%s.%s" $SubDomain (tpl $domain $Values) -}}
    {{- else}}
    {{- $domain = printf "%s" (tpl $domain $Values) -}}
    {{- end}}
    {{- if $Protocol }}
    {{- $domain = printf "%s://%s" $Protocol $domain -}}
    {{- end}}
    {{- if $Path }}
    {{- $domain = printf "%s%s" $domain $Path -}}
    {{- end}}
    {{- $NewDomains = append $NewDomains $domain -}}
{{- end -}}
{{ $NewDomains | toJson }}
{{- end -}}
{{/*
Generate list of domains with subdomain and/or path
*/}}

{{- define "rrst.domains.ingress" -}}
{{- $Values := .Values }}
{{- $System := .Values.ingress }}
{{- include "rrst.domains" (dict "Values" $.Values "system" $System) }}
{{- end -}}
{{/*
Fails the render when the chart is installed with the `host` value earlier versions used (now service.host, defaulting
to mail.<global.domain>), rather than silently serving a different name. Included from 1_deployments/service.yaml.
*/}}
{{- define "server.assertHost" -}}
{{- if .Values.host -}}
{{- fail "`host` has moved to `service.host`, and defaults to mail.<global.domain>: set --set global.domain=example.com (and service.host only for a name other than mail.example.com)." -}}
{{- end -}}
{{- /* Assigned, not emitted: this include sits among the other asserts and must render nothing. */ -}}
{{- $_ := required "service.host is required: the server's public host name." .Values.service.host -}}
{{- end -}}

{{/*
"true" when `host` can get a real certificate: not localhost, *.localhost or *.local. Usage: include "server.publicHost" "mail.example.com"
*/}}
{{- define "server.publicHost" -}}
{{- if not (or (eq . "localhost") (hasSuffix ".localhost" .) (hasSuffix ".local" .)) -}}
true
{{- end -}}
{{- end -}}

{{/* "true" when this chart creates the Gateway itself (see 3_gateways/api.yaml); empty when it attaches to someone else's. */}}
{{- define "server.ownsGateway" -}}
{{- if and .Values.gateway.create (eq "api-gateway" (tpl .Values.gateway.name .)) (eq .Release.Namespace (tpl .Values.gateway.namespace .)) -}}
true
{{- end -}}
{{- end -}}

{{/* "true" when tls-certs.yaml issues a cert-manager Certificate for `host`. */}}
{{- define "server.certificateEnabled" -}}
{{- if and .Values.gateway.tls (eq (include "server.publicHost" (include "rrst.render" (dict "value" .Values.service.host "context" .))) "true") -}}
true
{{- end -}}
{{- end -}}

{{/*
The Gateway listener serving HTTPS for `host`, or empty when nothing does: "https" on the chart's own Gateway, or
gateway.httpsListener on a Gateway it doesn't own - that listener must terminate TLS with this release's
<host>-tls-cert Secret (see values.yaml's gateway.httpsListener).
*/}}
{{- define "server.httpsListener" -}}
{{- if eq (include "server.certificateEnabled" .) "true" -}}
{{- if eq (include "server.ownsGateway" .) "true" -}}
https
{{- else -}}
{{- $listener := tpl (.Values.gateway.httpsListener | default "") . -}}
{{- /*
Fail rather than silently fall back to plain HTTP: an upgrade of a TLS deployment (e.g. onto a shared Gateway, or from a
chart version that didn't need this value) would otherwise move the route to the http listener, drop the HTTPS redirect
and switch every derived public URL (CORS, booking links, autodiscover, mail__auth_server_url) to http://.
*/ -}}
{{- if not $listener -}}
{{- fail (printf "gateway.tls is true and %q can get a certificate, but the chart doesn't own Gateway %s/%s, so it doesn't know which of its listeners serves HTTPS. Set gateway.httpsListener to the name of that Gateway's HTTPS listener for this host (terminating TLS with the %s-tls-cert Secret), or set gateway.tls=false to serve plain HTTP." (include "rrst.render" (dict "value" .Values.service.host "context" .)) (tpl .Values.gateway.namespace .) (tpl .Values.gateway.name .) (include "rrst.render" (dict "value" .Values.service.host "context" .))) -}}
{{- end -}}
{{- $listener -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/*
The Gateway listener serving HTTPS for authServer.host, or empty: only when `host` itself is served over HTTPS, the
auth-server subchart is installed and issues a certificate for its host (its own tls-certs.yaml, which still skips any
host containing ".local"), and a listener exists - "https-auth" on the chart's own Gateway, gateway.authHttpsListener on
someone else's. The subchart's own HTTPRoute only attaches to "http", so 3_gateways/api.yaml routes this one.
*/}}
{{- define "server.authHttpsListener" -}}
{{- $host := include "rrst.render" (dict "value" .Values.authServer.host "context" .) -}}
{{- if and .Values.authServer.create (include "server.httpsListener" .) (eq (include "server.publicHost" $host) "true") (not (contains ".local" $host)) (ne $host (include "rrst.render" (dict "value" .Values.service.host "context" .))) -}}
{{- if eq (include "server.ownsGateway" .) "true" -}}
https-auth
{{- else -}}
{{- tpl (.Values.gateway.authHttpsListener | default "") . -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/*
Fails the render when the bundled auth-server would be unreachable. Sign-in sends browsers to authServer.host
(mail__auth_server_url), and the auth-server subchart routes that host on its own gateway.name/gateway.namespace, which a
parent chart can't pass down - they must be set under authServer too:
- a public `host` with authServer.host still a localhost name (the auth.localhost default) redirects every visitor to a
  host that doesn't resolve for them;
- on a Gateway this chart doesn't own, authServer.gateway.name/namespace still pointing at the default api-gateway
  attach the auth-server HTTPRoute to a Gateway that doesn't exist.
*/}}
{{- define "server.assertAuthServerRouting" -}}
{{- if .Values.authServer.create -}}
{{- $authHost := include "rrst.render" (dict "value" .Values.authServer.host "context" .) -}}
{{- if and (eq (include "server.publicHost" (include "rrst.render" (dict "value" .Values.service.host "context" .))) "true") (ne (include "server.publicHost" $authHost) "true") -}}
{{- fail (printf "service.host %q is public but authServer.host is %q, so sign-in would redirect every browser to a host it can't reach. Set authServer.host to the auth-server's public name, e.g. --set authServer.host=auth.%s (and route it through your Gateway)." (include "rrst.render" (dict "value" .Values.service.host "context" .)) $authHost (include "rrst.render" (dict "value" .Values.global.domain "context" .))) -}}
{{- end -}}
{{- if ne (include "server.ownsGateway" .) "true" -}}
{{- $gatewayName := tpl .Values.gateway.name . -}}
{{- $gatewayNamespace := tpl .Values.gateway.namespace . -}}
{{- $authGateway := .Values.authServer.gateway | default dict -}}
{{- $authGatewayName := tpl ($authGateway.name | default "api-gateway") . -}}
{{- $authGatewayNamespace := tpl ($authGateway.namespace | default "{{ .Release.Namespace }}") . -}}
{{- if or (ne $authGatewayName $gatewayName) (ne $authGatewayNamespace $gatewayNamespace) -}}
{{- fail (printf "The server attaches to Gateway %s/%s, but the bundled auth-server's HTTPRoute attaches to %s/%s. Set authServer.gateway.name=%s and authServer.gateway.namespace=%s too." $gatewayNamespace $gatewayName $authGatewayNamespace $authGatewayName $gatewayName $gatewayNamespace) -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/* The ServiceAccount the server pod runs as, or empty for the namespace's "default". */}}
{{- define "server.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- tpl (.Values.serviceAccount.name | default "") . | default (include "rrst.fullname" .) -}}
{{- else -}}
{{- tpl (.Values.serviceAccount.name | default "") . -}}
{{- end -}}
{{- end -}}

{{/*
Fails the render when the bundled postfix-bridge would run with its placeholder identity on a public deployment: Postfix
would HELO as mail.localhost with a self-signed certificate, and only accept outbound mail from example.com. Also refuses
the two mail transports at once: with SES sending, Postfix would still be receiving mail nothing routes to it.
*/}}
{{- define "server.assertPostfixBridge" -}}
{{- if and .Values.postfixBridge.create (eq .Values.mail.transport.provider "ses") -}}
{{- fail "mail.transport.provider is \"ses\" but postfixBridge.create is true, so this release would both send through SES and run its own Postfix. Set postfixBridge.create=false (inbound mail then comes from ses-bridge), or mail.transport.provider=postfix." -}}
{{- end -}}
{{- if and .Values.postfixBridge.create (eq (include "server.publicHost" (include "rrst.render" (dict "value" .Values.service.host "context" .))) "true") -}}
{{- if eq (include "server.publicHost" .Values.postfixBridge.hostname) "" -}}
{{- fail (printf "host %q is public but postfixBridge.hostname is %q. Set it to Postfix's public MX host name, e.g. --set postfixBridge.hostname=%s." (include "rrst.render" (dict "value" .Values.service.host "context" .)) .Values.postfixBridge.hostname (.Values.mail.mxHostname | default (include "rrst.render" (dict "value" .Values.service.host "context" .)))) -}}
{{- end -}}
{{- /* Only a placeholder while it isn't the deployment's own domain, which is what it should usually be. */ -}}
{{- if and (eq (toString .Values.postfixBridge.domains) "example.com") (ne (toString .Values.global.domain) "example.com") -}}
{{- fail (printf "postfixBridge.domains is still example.com. Set it to the comma-separated domains this deployment sends mail from, e.g. --set postfixBridge.domains=%s." (toString .Values.global.domain)) -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/*
"true" when the site is served over HTTPS: a certificate is issued for `host` and a Gateway listener terminates TLS with
it. Empty otherwise - the routes then attach to the plain HTTP listener, with no redirect, and public URLs use http.
*/}}
{{- define "server.tlsEnabled" -}}
{{- if include "server.httpsListener" . -}}
true
{{- end -}}
{{- end -}}

{{/*
The storageClassName a PersistentVolumeClaim renders with. storageClassName is immutable, so once the claim exists its
live value wins (including one the cluster's default storage class filled in, or the "default" earlier chart versions
wrote): changing common.storageClass or the per-volume value only applies to new claims. Otherwise the value, omitted
when it's "default" (the cluster's default class). Renders the whole `storageClassName:` line, or nothing.
Usage: include "server.pvcStorageClass" (dict "name" $claimName "value" .Values.mail.dkim.storage.storageClassName "context" $)
*/}}
{{- define "server.pvcStorageClass" -}}
{{- $existing := (lookup "v1" "PersistentVolumeClaim" .context.Release.Namespace .name) | default dict -}}
{{- $existingClass := dig "spec" "storageClassName" "" $existing -}}
{{- $class := tpl (.value | default "") .context -}}
{{- if $existingClass -}}
storageClassName: {{ $existingClass | quote }}
{{- else if and $class (ne $class "default") -}}
storageClassName: {{ $class | quote }}
{{- end -}}
{{- end -}}

{{/*
Fails the render (with `required`, so `helm lint` still passes) when generated secrets can't be kept stable: without
cluster access (`helm template`, a GitOps controller rendering the chart, `--dry-run`) `lookup` returns nothing, so every
render would generate new cookie/session/escrow-audit secrets - logging everyone out on each sync and breaking the escrow
audit chain. Detected by looking up the release namespace's "kube-root-ca.crt" ConfigMap (published into every namespace),
which a namespace-scoped install can read; only when that finds nothing (e.g. `--create-namespace`, which renders before
the namespace exists) is the cluster-scoped "default" Namespace tried. lookup fails the render on Forbidden, so the
cluster-scoped probe must not come first.
Usage: include "server.assertStableSecrets" (dict "missing" (list "cookies.secret" ...) "context" $)
*/}}
{{- define "server.assertStableSecrets" -}}
{{- if and .missing (not .context.Values.secrets.existingSecret) -}}
{{- $clusterAccess := lookup "v1" "ConfigMap" .context.Release.Namespace "kube-root-ca.crt" -}}
{{- if not $clusterAccess -}}
{{- $clusterAccess = lookup "v1" "Namespace" "" "default" -}}
{{- end -}}
{{- if not $clusterAccess -}}
{{- required (printf "Rendering without cluster access (helm template, GitOps, --dry-run), so generated secrets would change on every render. Set %s explicitly, or secrets.existingSecret to a Secret you manage." (join ", " .missing)) "" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/* The public base URL of this deployment, e.g. https://mail.example.com. */}}
{{- define "server.publicUrl" -}}
{{- printf "%s://%s" (ternary "https" "http" (eq (include "server.tlsEnabled" .) "true")) (include "rrst.render" (dict "value" .Values.service.host "context" .)) -}}
{{- end -}}

{{/*
A secret value that must be supplied: fails the render when it's empty or still one of the publicly-known development
defaults. Usage: include "server.requiredSecret" (dict "value" $value "name" "auth.secret" "defaults" (list "..."))
*/}}
{{- define "server.requiredSecret" -}}
{{- $value := required (printf "%s is required: set it to a unique, secret value." .name) (.value | default "") -}}
{{- if has $value (.defaults | default list) -}}
{{- fail (printf "%s is still a publicly-known development default; set it to a unique, secret value." .name) -}}
{{- end -}}
{{- $value -}}
{{- end -}}

{{/*
A base64-encoded secret that's generated once and kept: the explicit value when one is set, otherwise the value already
stored in the release's Secret (so it survives upgrades), otherwise a new random one.
Usage: include "server.persistedSecret" (dict "value" .Values.cookies.secret "stored" $storedB64 "context" $)
*/}}
{{- define "server.persistedSecret" -}}
{{- $explicit := tpl (.value | default "") .context -}}
{{- if $explicit -}}
{{- $explicit | b64enc -}}
{{- else if .stored -}}
{{- .stored -}}
{{- else -}}
{{- randAlphaNum 48 | b64enc -}}
{{- end -}}
{{- end -}}

{{/*
The `env` entries that carry the bundled databases' passwords into the server container, straight from the Secrets the
Bitnami subcharts create (their names and keys are deterministic: fullnameOverride, or auth.existingSecret). Referenced
rather than read with `lookup` at render time, which finds nothing on a fresh install (the subchart Secrets are created by
the same install), leaving the server without credentials until a second `helm upgrade`. A connection URL embeds the
password through Kubernetes' `$(VAR)` expansion, so a password you set yourself must be URL-safe (the generated ones are).
Kubernetes only starts the container once the referenced Secrets exist, and re-reads them whenever a pod starts.
Renders nothing when no bundled database uses a password.
*/}}
{{- define "server.datastoreEnv" -}}
{{- $v := .Values -}}
{{- if and $v.mongodb.create $v.mongodb.auth.enabled (not $v.mongodb.url) }}
{{- $secret := dict "name" (tpl ($v.mongodb.auth.existingSecret | default $v.mongodb.fullnameOverride) .) "key" "mongodb-root-password" }}
{{- range $name := list "acl" "mongo" }}
{{- if not (get (get $v.service.mongodb $name) "url") }}
- name: datastores__{{ $name }}__password
  valueFrom:
    secretKeyRef:
      name: {{ $secret.name }}
      key: {{ $secret.key }}
{{- end }}
{{- end }}
{{- end }}
{{- if and $v.postgresql.create $v.postgresql.auth.enablePostgresUser (not $v.postgresql.url) }}
{{- $key := ternary (tpl ($v.postgresql.auth.secretKeys.adminPasswordKey | default "postgres-password") .) "postgres-password" (not (empty $v.postgresql.auth.existingSecret)) }}
- name: RAPIDMX_POSTGRES_PASSWORD
  valueFrom:
    secretKeyRef:
      name: {{ tpl ($v.postgresql.auth.existingSecret | default $v.postgresql.fullnameOverride) . }}
      key: {{ $key }}
{{- if not $v.service.postgresql.acl.url }}
- name: datastores__acl__password
  value: $(RAPIDMX_POSTGRES_PASSWORD)
{{- end }}
{{- if not $v.service.postgresql.sql.url }}
{{- $sqlHost := include "rrst.render" (dict "value" $v.service.postgresql.sql.host "context" .) | default $v.postgresql.fullnameOverride }}
{{- $sqlDatabase := include "rrst.render" (dict "value" $v.service.postgresql.sql.name "context" .) }}
- name: datastores__sql__url
  value: {{ printf "postgres://postgres:$(RAPIDMX_POSTGRES_PASSWORD)@%s/%s" $sqlHost $sqlDatabase | quote }}
{{- end }}
{{- end }}
{{- if and $v.redis.create $v.redis.auth.enabled }}
{{- $key := ternary (tpl ($v.redis.auth.existingSecretPasswordKey | default "redis-password") .) "redis-password" (not (empty $v.redis.auth.existingSecret)) }}
- name: RAPIDMX_REDIS_PASSWORD
  valueFrom:
    secretKeyRef:
      name: {{ tpl ($v.redis.auth.existingSecret | default $v.redis.fullnameOverride) . }}
      key: {{ $key }}
{{- $redisUrl := tpl $v.redis.url . | replace "redis://" "redis://:$(RAPIDMX_REDIS_PASSWORD)@" }}
{{- range $name := list "cache" "events" "events_publish" "logs" }}
- name: datastores__{{ $name }}__url
  value: {{ $redisUrl | quote }}
{{- end }}
{{- end }}
{{- end -}}

{{/*
The vault's address: global.openbao.address, which defaults to the OpenBao the install scripts put in the cluster and is
pointed at your own when you run one already.
*/}}
{{- define "server.openbaoAddress" -}}
{{- include "rrst.render" (dict "value" .Values.global.openbao.address "context" .) -}}
{{- end -}}

{{/*
"true" when OpenBao holds this release's secrets and External Secrets delivers them into the Kubernetes Secrets the pods
read - in which case this chart doesn't render those Secrets itself, and the values that would otherwise be required
(global.authSecret, global.mailIngestSecret) are generated in the vault instead.
*/}}
{{- define "server.vaultManagedSecrets" -}}
{{- if and .Values.global.openbao.enabled .Values.externalSecrets.enabled -}}
true
{{- end -}}
{{- end -}}

{{/*
The External Secrets API version this cluster serves, failing with something actionable when the operator isn't
installed at all - its CRDs are cluster-wide, so a chart can't bring them along.
*/}}
{{- define "server.externalSecretsApiVersion" -}}
{{- if .Capabilities.APIVersions.Has "external-secrets.io/v1" -}}
external-secrets.io/v1
{{- else if .Capabilities.APIVersions.Has "external-secrets.io/v1beta1" -}}
external-secrets.io/v1beta1
{{- else -}}
{{- fail "externalSecrets.enabled is true but this cluster has no External Secrets Operator (no external-secrets.io CRDs). Install it first (helm install external-secrets external-secrets/external-secrets -n external-secrets --create-namespace --set installCRDs=true; single_node_install.sh and deploy/aws do this for you), or set externalSecrets.enabled=false to keep the chart's own Kubernetes Secrets." -}}
{{- end -}}
{{- end -}}

{{/*
Fails the render when a secret this chart must have wasn't supplied and nothing else provides it. With OpenBao the vault
generates them, so only a deployment without it needs these set.
*/}}
{{- define "server.assertSuppliedSecrets" -}}
{{- /* The subcharts only see `global`, so the two switches have to agree by hand. */ -}}
{{- if eq (include "server.vaultManagedSecrets" .) "true" -}}
{{- if not (include "rrst.render" (dict "value" .Values.global.openbao.address "context" .)) -}}
{{- fail "global.openbao.enabled is true but global.openbao.address is empty: point it at the OpenBao this cluster runs (e.g. http://openbao.openbao.svc:8200), which single_node_install.sh and deploy/aws install for you." -}}
{{- end -}}
{{- if and (eq .Values.global.openbao.auth.method "token") (not (include "rrst.render" (dict "value" .Values.global.openbao.auth.tokenSecret "context" .))) -}}
{{- fail "global.openbao.auth.method is \"token\" but global.openbao.auth.tokenSecret is empty: name a Secret holding a token that may read global.openbao.secretsPath, or use method \"kubernetes\"." -}}
{{- end -}}
{{- if and (eq .Values.global.openbao.auth.method "kubernetes") (not (include "rrst.render" (dict "value" .Values.global.openbao.auth.kubernetes.role "context" .))) -}}
{{- fail "global.openbao.auth.method is \"kubernetes\" but global.openbao.auth.kubernetes.role is empty: set the OpenBao role bound to this namespace's ServiceAccount." -}}
{{- end -}}
{{- end -}}
{{- if and (eq (include "server.vaultManagedSecrets" .) "true") .Values.postfixBridge.create -}}
{{- $version := (.Subcharts.postfixBridge).Chart.Version | default "0.0.0" -}}
{{- if not (semverCompare ">=1.2.0-0" $version) -}}
{{- fail (printf "The bundled postfix-bridge is %s, which can't read the ingest secret from the vault's Secret (it needs ingestSecretRef, added in 1.2.0). Upgrade the dependency, or set externalSecrets.enabled=false and supply global.mailIngestSecret yourself." $version) -}}
{{- end -}}
{{- end -}}
{{- if ne (include "server.vaultManagedSecrets" .) "true" -}}
{{- $_ := include "server.requiredSecret" (dict "value" (tpl .Values.auth.secret .) "name" "auth.secret (or global.authSecret)" "defaults" (list "MyPasswordIsSecure")) -}}
{{- $_ = include "server.requiredSecret" (dict "value" (tpl .Values.mail.ingestSecret .) "name" "global.mailIngestSecret (or mail.ingestSecret)" "defaults" (list "ChangeMeIngestSecret")) -}}
{{- end -}}
{{- end -}}

{{/* The kv v2 mount and the path this release's secrets live at, both from global.openbao. */}}
{{- define "server.vaultKvMount" -}}
{{- include "rrst.render" (dict "value" .Values.global.openbao.kvMount "context" .) -}}
{{- end -}}

{{- define "server.vaultSecretsPath" -}}
{{- include "rrst.render" (dict "value" .Values.global.openbao.secretsPath "context" .) -}}
{{- end -}}

{{/*
How External Secrets authenticates to the vault: a token Secret (the bundled vault's own, or one naming a token you
created) or Kubernetes auth against a shared vault's mount.
*/}}
{{- define "server.vaultAuth" -}}
{{- $auth := .Values.global.openbao.auth -}}
{{- if eq $auth.method "kubernetes" -}}
kubernetes:
  mountPath: {{ include "rrst.render" (dict "value" $auth.kubernetes.mountPath "context" .) | quote }}
  role: {{ include "rrst.render" (dict "value" $auth.kubernetes.role "context" .) | quote }}
  serviceAccountRef:
    name: {{ include "rrst.render" (dict "value" $auth.kubernetes.serviceAccount "context" .) | default "default" | quote }}
{{- else -}}
tokenSecretRef:
  name: {{ include "rrst.render" (dict "value" $auth.tokenSecret "context" .) | quote }}
  key: {{ $auth.tokenSecretKey | default "token" | quote }}
{{- end }}
{{- end -}}
