{{/******************************** GENERAL ********************************/}}

{{/*
The full URL to the deployed app.
*/}}
{{- define "rrst.appURL" -}}
{{ ternary "https" "http" (.Values.global.gateway.tls | default false) }}://{{ tpl (toString
        (.Values.global.serverHost | default (printf "mail.%s" (tpl (toString .Values.global.domain) .)))) . }}
{{- end -}}

{{/*
Create chart name and version as used by the chart label.
*/}}
{{- define "rrst.chart" -}}
{{-   printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Create a default fully qualified app name.
We truncate at 63 chars because some Kubernetes name fields are limited to this (by the DNS naming spec).
If release name contains chart name it will be used as a full name.
*/}}
{{- define "rrst.fullname" -}}
{{-   if .Values.fullnameOverride -}}
{{-     .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{-   else -}}
{{-     $name := default .Chart.Name .Values.nameOverride -}}
{{-     if contains $name .Release.Name -}}
{{-       .Release.Name | trunc 63 | trimSuffix "-" -}}
{{-     else -}}
{{-       printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{-     end -}}
{{-   end -}}
{{- end -}}

{{/*
Common labels
*/}}
{{- define "rrst.labels" -}}
app.kubernetes.io/name: {{ include "rrst.name" . }}
helm.sh/chart: {{ include "rrst.chart" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{-   if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{-   end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{/* vim: set filetype=mustache: */}}
{{/*
Expand the name of the chart.
*/}}
{{- define "rrst.name" -}}
{{-   default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Renders a value that contains template.
Usage:
{{ include "rrst.render" ( dict "value" .Values.path.to.the.Value "context" $) }}
*/}}
{{- define "rrst.render" -}}
{{-   if typeIs "string" .value }}
{{-     tpl .value .context }}
{{-   else }}
{{-     tpl (.value | toYaml) .context }}
{{-   end }}
{{- end -}}

{{/* The ServiceAccount the server pod runs as, or empty for the namespace's "default". */}}
{{- define "rrst.serviceAccountName" -}}
{{-   if .Values.global.serviceAccount.create -}}
{{-     tpl (.Values.global.serviceAccount.name | default "") . | default (include "rrst.fullname" .) -}}
{{-   else -}}
{{-     tpl (.Values.global.serviceAccount.name | default "") . -}}
{{-   end -}}
{{- end -}}

{{/******************************** GATEWAY ********************************/}}

{{/*
Generate list of domains with subdomain and/or path
*/}}
{{- define "rrst.domains" -}}
{{-   $Values := .Values }}
{{-   $SubDomain := "" }}
{{-   if and .system (hasKey .system "host_subdomain") }}
{{-     $SubDomain = .system.host_subdomain }}
{{-   end -}}
{{-   $Path := "" }}
{{-   if .path }}
{{-     $Path = .path }}
{{-   end -}}
{{-   $Protocol := "" }}
{{-   if .protocol }}
{{-     $Protocol = .protocol }}
{{-   end -}}
{{-   $NewDomains := list  }}
{{-   $CurrentDomains := list $Values.domain }}
{{-   if and (hasKey $Values "alias_domains") (kindIs "slice" $Values.alias_domains)}}
{{-     $CurrentDomains = concat $CurrentDomains $Values.alias_domains -}}
{{-   end -}}
{{-   range $domain := $CurrentDomains -}}
{{-     if $SubDomain }}
{{-       $domain = printf "%s.%s" $SubDomain (tpl $domain $Values) -}}
{{-     else}}
{{-       $domain = printf "%s" (tpl $domain $Values) -}}
{{-     end}}
{{-     if $Protocol }}
{{-       $domain = printf "%s://%s" $Protocol $domain -}}
{{-     end}}
{{-     if $Path }}
{{-       $domain = printf "%s%s" $domain $Path -}}
{{-     end}}
{{-     $NewDomains = append $NewDomains $domain -}}
{{-   end -}}
{{    $NewDomains | toJson }}
{{- end -}}

{{/*
Generate list of domains with subdomain and/or path
*/}}
{{- define "rrst.domains.ingress" -}}
{{-   $Values := .Values }}
{{-   $System := .Values.ingress }}
{{-   include "rrst.domains" (dict "Values" $.Values "system" $System) }}
{{- end -}}

{{/*
Generate certificates for nginx
*/}}
{{- define "rrst.gen-nginx-certs" -}}
{{-   $ca := genCA "xbe-ca" 365 -}}
{{-   $cert := genSignedCert . nil nil 365 $ca -}}
tls.crt: {{ $cert.Cert | b64enc }}
tls.key: {{ $cert.Key | b64enc }}
{{- end -}}

{{/*
"true" when `host` can get a real certificate: not localhost, *.localhost or *.local. Usage: include "rrst.publicHost" "example.com"
*/}}
{{- define "rrst.publicHost" -}}
{{-   if not (or (eq . "localhost") (hasSuffix ".localhost" .) (hasSuffix ".local" .)) -}}
true
{{-   end -}}
{{- end -}}

{{/*
"true" when this chart's own `.Values.host` will actually get a TLS certificate: global.gateway.tls is on and the
rendered host isn't localhost or *.local - matches what the ACME HTTP-01 solver in tls-certs.yaml can reach. Usage:
include "rrst.certificate" $
*/}}
{{- define "rrst.certificate" -}}
{{-   $host := include "rrst.render" (dict "value" .Values.host "context" .) -}}
{{-   if and .Values.global.gateway.tls (ne $host "localhost") (not (contains ".local" $host)) -}}
true
{{-   end -}}
{{- end -}}

{{/*
"true" when TLS is terminated inside the service pod itself (global.gateway.tlsTermination: pod) rather than at the
Envoy/nginx Gateway - only meaningful when a certificate is actually issued (see rrst.certificate). Usage:
include "rrst.podTLS" $
*/}}
{{- define "rrst.podTLS" -}}
{{-   if and (eq (include "rrst.certificate" .) "true") (eq .Values.global.gateway.tlsTermination "pod") -}}
true
{{-   end -}}
{{- end -}}

{{/******************************** SECRETS ********************************/}}

{{/*
Fails the render (with `required`, so `helm lint` still passes) when generated secrets can't be kept stable: without
cluster access (`helm template`, a GitOps controller rendering the chart, `--dry-run`) `lookup` returns nothing, so every
render would generate new JWT/cookie/session secrets - logging everyone out on each sync. Detected by looking up the
release namespace's "kube-root-ca.crt" ConfigMap (published into every namespace), which a namespace-scoped install can
read; only when that finds nothing (e.g. `--create-namespace`, which renders before the namespace exists) is the
cluster-scoped "default" Namespace tried. lookup fails the render on Forbidden, so the cluster-scoped probe must not come
first.
Usage: include "rrst.assertStableSecrets" (dict "missing" (list "cookies.secret" ...) "context" $)
"always" checks even with global.secrets.existingSecret, for a secret that Secret doesn't cover.
*/}}
{{- define "rrst.assertStableSecrets" -}}
{{-   if and .missing (or .always (not .context.Values.global.secrets.existingSecret)) -}}
{{-     $clusterAccess := lookup "v1" "ConfigMap" .context.Release.Namespace "kube-root-ca.crt" -}}
{{-     if not $clusterAccess -}}
{{-       $clusterAccess = lookup "v1" "Namespace" "" "default" -}}
{{-     end -}}
{{-     if not $clusterAccess -}}
{{-       $instead := ternary "" ", or global.secrets.existingSecret to a Secret you manage" (.always | default false) -}}
{{-       required (printf "Rendering without cluster access (helm template, GitOps, --dry-run), so generated secrets would change on every render. Set %s explicitly%s." (join ", " .missing) $instead) "" -}}
{{-     end -}}
{{-   end -}}
{{- end -}}

{{/*
The External Secrets API version this cluster serves, failing with something actionable when the operator isn't
installed - its CRDs are cluster-wide, so a chart can't bring them along.
*/}}
{{- define "rrst.externalSecretsApiVersion" -}}
{{-   if .Capabilities.APIVersions.Has "external-secrets.io/v1" -}}
external-secrets.io/v1
{{-   else if .Capabilities.APIVersions.Has "external-secrets.io/v1beta1" -}}
external-secrets.io/v1beta1
{{-   else -}}
{{-     fail "externalSecrets.enabled is true but this cluster has no External Secrets Operator (no external-secrets.io CRDs). Install it first (helm install external-secrets external-secrets/external-secrets -n external-secrets --create-namespace --set installCRDs=true; scripts/k3s_install.sh does this for you), or set externalSecrets.enabled=false to keep the chart's own Kubernetes Secrets." -}}
{{-   end -}}
{{- end -}}

{{/*
A base64-encoded secret that's generated once and kept: the explicit value when one is set, otherwise the value already
stored in the release's Secret (so it survives upgrades), otherwise a new random one.
Usage: include "rrst.persistedSecret" (dict "value" .Values.cookies.secret "stored" $storedB64 "context" $)
*/}}
{{- define "rrst.persistedSecret" -}}
{{-   $explicit := tpl (.value | default "") .context -}}
{{-   if $explicit -}}
{{-     $explicit | b64enc -}}
{{-   else if .stored -}}
{{-     .stored -}}
{{-   else -}}
{{-     randAlphaNum 48 | b64enc -}}
{{-   end -}}
{{- end -}}

{{/*
A secret value that must be supplied: fails the render when it's empty or still one of the publicly-known development
defaults. Usage: include "rrst.requiredSecret" (dict "value" $value "name" "auth.secret" "defaults" (list "..."))
*/}}
{{- define "rrst.requiredSecret" -}}
{{-   $value := required (printf "%s is required: set it to a unique, secret value." .name) (.value | default "") -}}
{{-   if has $value (.defaults | default list) -}}
{{-     fail (printf "%s is still a publicly-known development default; set it to a unique, secret value." .name) -}}
{{-   end -}}
{{-   $value -}}
{{- end -}}

{{/*
Where this deployment's secrets live: the OpenBao at global.openbao.address, which the install script sets up or you
point at your own. As a subchart of the RapidMX server those values come from that release, which is how both ends read
the same JWT secret.
*/}}
{{- define "rrst.vaultManagedSecrets" -}}
{{-   if and .Values.global.externalSecrets.enabled .Values.global.openbao -}}
{{-     if .Values.global.openbao.enabled -}}
true
{{-     end -}}
{{-   end -}}
{{- end -}}

{{- define "rrst.vaultAddress" -}}
{{-   include "rrst.render" (dict "value" .Values.global.openbao.address "context" .) -}}
{{- end -}}

{{- define "rrst.vaultKvMount" -}}
{{-   include "rrst.render" (dict "value" .Values.global.openbao.kvMount "context" .) | default "secret" -}}
{{- end -}}

{{- define "rrst.vaultSecretsPath" -}}
{{-   include "rrst.render" (dict "value" .Values.global.openbao.secretsPath "context" .) | default (printf "%s/secrets" (include "rrst.fullname" .)) -}}
{{- end -}}

{{/* How External Secrets authenticates: a token Secret, or Kubernetes auth against a shared vault's mount. */}}
{{- define "rrst.vaultAuth" -}}
{{-   $auth := .Values.global.openbao.auth -}}
{{-   if not (include "rrst.vaultAddress" .) -}}
{{-     fail "global.openbao.enabled is true but global.openbao.address is empty: point it at the OpenBao this cluster runs (e.g. http://openbao.openbao.svc:8200), which scripts/k3s_install.sh installs for you." -}}
{{-   end -}}
{{-   if and (eq $auth.method "kubernetes") (not (include "rrst.render" (dict "value" $auth.kubernetes.role "context" .))) -}}
{{-     fail "global.openbao.auth.method is \"kubernetes\" but global.openbao.auth.kubernetes.role is empty: set the OpenBao role bound to this namespace's ServiceAccount." -}}
{{-   end -}}
{{-   if eq $auth.method "kubernetes" -}}
kubernetes:
  mountPath: {{ include "rrst.render" (dict "value" $auth.kubernetes.mountPath "context" .) | quote }}
  role: {{ include "rrst.render" (dict "value" $auth.kubernetes.role "context" .) | quote }}
  serviceAccountRef:
    name: {{ include "rrst.render" (dict "value" $auth.kubernetes.serviceAccount "context" .) | default "default" | quote }}
{{-   else -}}
tokenSecretRef:
  name: {{ include "rrst.render" (dict "value" $auth.tokenSecret "context" .) | default (printf "%s-openbao-eso" (include "rrst.fullname" .)) | quote }}
  key: {{ $auth.tokenSecretKey | default "token" | quote }}
{{-   end }}
{{- end -}}

{{/****************************** AUTH SERVER ******************************/}}

{{/*
Creates the default accounts used to seed the auth-server's initial user database.
*/}}
{{- define "rrst.getDefaultAccounts" -}}
{{-   $accounts := dig "defaultAccounts" list ($.Values.global | default dict) -}}
{{-   range $account := $accounts -}}
{{-     if (not $account.password) -}}
{{-       $_ := set $account "password" (randAlphaNum 48 | b64enc) -}}
{{-     end -}}
{{-   end -}}
{{    $accounts | toJson | quote -}}
{{- end -}}

{{/******************************** RAPIDMX ********************************/}}

{{/*
Fails the render when the bundled postfix-bridge would run with its placeholder identity on a public deployment: Postfix
would HELO as mail.localhost with a self-signed certificate, and only accept outbound mail from example.com. Also refuses
the two mail transports at once: with SES sending, Postfix would still be receiving mail nothing routes to it.
*/}}
{{/*
The authserv-id whose Authentication-Results headers the server believes (mail__security__trusted_authserv_id): the DKIM result
its inbound MTA stamps. mail.trustedAuthservId when set; otherwise, with the bundled Postfix, Postfix's own host name, which is
the id its OpenDKIM puts on every result; otherwise empty - a different MTA (ses-bridge, your own) has to be named.
Usage: include "rapidmx.trustedAuthservId" .
*/}}
{{- define "rapidmx.trustedAuthservId" -}}
{{-   if .Values.mail.trustedAuthservId -}}
{{-     include "rrst.render" (dict "value" .Values.mail.trustedAuthservId "context" .) -}}
{{-   else if .Values.postfixBridge.create -}}
{{-     include "rrst.render" (dict "value" .Values.postfixBridge.hostname "context" .) -}}
{{-   end -}}
{{- end -}}

{{/*
"true" when `global.domain` is one a public certificate authority could never issue for: `localhost` or a domain ending in
`.local`, `.localhost`, `.test` or `.invalid` (the reserved-for-testing/local-use TLDs). Usage: include "rapidmx.isLocalDomain" .
*/}}
{{- define "rapidmx.isLocalDomain" -}}
{{-   $domain := toString .Values.global.domain -}}
{{-   if or (eq $domain "localhost") (hasSuffix ".local" $domain) (hasSuffix ".localhost" $domain) (hasSuffix ".test" $domain) (hasSuffix ".invalid" $domain) -}}
true
{{-   end -}}
{{- end -}}

{{/*
Resolves mail.signingEnrollment.backend to the concrete backend restapi's mail:pki:signing_enrollment:backend takes: "auto" (the
default) becomes "rfc8823" for a real domain and "manual" for a local/test one (rapidmx.isLocalDomain); "rfc8823"/"manual" pass
through unchanged; anything else fails the render. Usage: include "rapidmx.signingEnrollmentBackend" .
*/}}
{{- define "rapidmx.signingEnrollmentBackend" -}}
{{-   $backend := .Values.mail.signingEnrollment.backend -}}
{{-   if eq $backend "auto" -}}
{{-     if eq (include "rapidmx.isLocalDomain" .) "true" -}}
manual
{{-     else -}}
rfc8823
{{-     end -}}
{{-   else if eq $backend "rfc8823" -}}
rfc8823
{{-   else if eq $backend "manual" -}}
manual
{{-   else -}}
{{-     fail (printf "mail.signingEnrollment.backend is %q - it must be \"auto\", \"rfc8823\" or \"manual\"." (toString $backend)) -}}
{{-   end -}}
{{- end -}}

{{/*
The e-mail address the RFC 8823 ACME account registers with: mail.signingEnrollment.contactEmail when set, else
global.certmanager.email. Usage: include "rapidmx.signingEnrollmentContactEmail" .
*/}}
{{- define "rapidmx.signingEnrollmentContactEmail" -}}
{{-   $email := include "rrst.render" (dict "value" .Values.mail.signingEnrollment.contactEmail "context" .) -}}
{{-   if $email -}}
{{ $email }}
{{-   else -}}
{{ include "rrst.render" (dict "value" .Values.global.certmanager.email "context" .) }}
{{-   end -}}
{{- end -}}

{{/*
Fails the render when mail.signingEnrollment doesn't make sense: an unrecognized backend (rapidmx.signingEnrollmentBackend already
fails for that) or, once resolved to "rfc8823", a directoryUrl that isn't https:// - RFC 8823 exchanges the account key and order
data over it, and a plain-HTTP CA is not one the automated flow will trust. Usage: include "rapidmx.assertSigningEnrollment" $
*/}}
{{- define "rapidmx.assertSigningEnrollment" -}}
{{-   $backend := include "rapidmx.signingEnrollmentBackend" . -}}
{{-   if eq $backend "rfc8823" -}}
{{-     $url := include "rrst.render" (dict "value" .Values.mail.signingEnrollment.directoryUrl "context" .) -}}
{{-     if not (hasPrefix "https://" $url) -}}
{{-       fail (printf "mail.signingEnrollment.directoryUrl is %q - an RFC 8823 ACME directory URL must be https://." $url) -}}
{{-     end -}}
{{-   end -}}
{{- end -}}

{{- define "rapidmx.assertPostfixBridge" -}}
{{-   if and .Values.postfixBridge.create (eq .Values.mail.transport.provider "ses") -}}
{{-     fail "mail.transport.provider is \"ses\" but postfixBridge.create is true, so this release would both send through SES and run its own Postfix. Set postfixBridge.create=false (inbound mail then comes from ses-bridge), or mail.transport.provider=postfix." -}}
{{-   end -}}
{{-   if and .Values.postfixBridge.create (eq (include "rrst.publicHost" (include "rrst.render" (dict "value" .Values.host "context" .))) "true") -}}
{{-     if eq (include "rrst.publicHost" .Values.postfixBridge.hostname) "" -}}
{{-       fail (printf "host %q is public but postfixBridge.hostname is %q. Set it to Postfix's public MX host name, e.g. --set postfixBridge.hostname=%s." (include "rrst.render" (dict "value" .Values.host "context" .)) .Values.postfixBridge.hostname (.Values.mail.mxHostname | default (include "rrst.render" (dict "value" .Values.host "context" .)))) -}}
{{-     end -}}
{{-     if and (eq (toString .Values.postfixBridge.domains) "example.com") (ne (toString .Values.global.domain) "example.com") -}}
{{-       fail (printf "postfixBridge.domains is still example.com. Set it to the comma-separated domains this deployment sends mail from, e.g. --set postfixBridge.domains=%s." (toString .Values.global.domain)) -}}
{{-     end -}}
{{-   end -}}
{{- end -}}

{{/*
Fails the render when a secret this chart must have wasn't supplied and nothing else provides it. With OpenBao the vault
generates them, so only a deployment without it needs these set.
*/}}
{{- define "rapidmx.assertSuppliedSecrets" -}}
{{-   if eq (include "rrst.vaultManagedSecrets" .) "true" -}}
{{-     if not (include "rrst.render" (dict "value" .Values.global.openbao.address "context" .)) -}}
{{-       fail "global.openbao.enabled is true but global.openbao.address is empty: point it at the OpenBao this cluster runs (e.g. http://openbao.openbao.svc:8200), which single_node_install.sh and deploy/aws install for you." -}}
{{-     end -}}
{{-   end -}}
{{- end -}}

{{/*
Generates the URL to the auth server.

Usage: include "rapidmx.authServerURL" .
*/}}
{{- define "rapidmx.authServerURL" -}}
{{- /* authserver.host is unset until the auth-server subchart's own default is merged in, which needs the subchart present in charts/ (it isn't for `helm lint` of a checkout, where the tarballs are ignored), so fall back to the same default global.jwt.issuer uses. */ -}}
{{-   $host := tpl (toString ($.Values.authserver.host | default (printf "auth.%s" (toString $.Values.global.domain)))) . -}}
{{-   if $.Values.global.gateway.tls -}}
{{-     printf "https://%s" $host -}}
{{-   else -}}
{{-     printf "http://%s" $host -}}
{{-   end -}}
{{- end -}}

{{/*
The address browsers reach this server at, e.g. https://mail.example.com: `host`, with https:// unless global.gateway.tls is off
(the same rule as rapidmx.authServerURL). No trailing slash. The public URLs of the plugins whose pages this server serves
(Autodiscover, Booking pages, Video Conferencing) are built on it.

Usage: include "rapidmx.serverURL" .
*/}}
{{- define "rapidmx.serverURL" -}}
{{-   printf "%s://%s" (ternary "https" "http" (.Values.global.gateway.tls | default false)) (include "rrst.render" (dict "value" .Values.host "context" .)) -}}
{{- end -}}

{{/*
Fails the render when `host` and `global.serverHost` name different hosts while the bundled auth-server's app_url is still the
one values.yaml derives from global.serverHost. The auth-server subchart renders its own values and can't see the top-level
`host` (`host` there is authserver.host), so it is given the server's host as a global; left to default, the auth-server's
"Return to App" button would point at mail.<global.domain> rather than the host this release serves. Usage:
include "rapidmx.assertServerHost" $
*/}}
{{- define "rapidmx.assertServerHost" -}}
{{-   $host := include "rrst.render" (dict "value" .Values.host "context" .) -}}
{{-   $shared := tpl (toString (.Values.global.serverHost | default (printf "mail.%s" (tpl (toString .Values.global.domain) .)))) . -}}
{{-   if and .Values.authserver.create (ne $host $shared) (contains "global.serverHost" (toString (dig "service" "config" "app_url" "" .Values.authserver))) -}}
{{-     fail (printf "host is %q but global.serverHost resolves to %q, and the bundled auth-server's app_url (the Return to App button on its account page) is built from global.serverHost. Set global.serverHost=%s alongside host (single_node_install.sh does), or set authserver.service.config.app_url yourself." $host $shared $host) -}}
{{-   end -}}
{{- end -}}

{{/*
The storageClassName a PersistentVolumeClaim renders with. storageClassName is immutable, so once the claim exists its
live value wins (including one the cluster's default storage class filled in, or the "default" earlier chart versions
wrote): changing common.storageClass or the per-volume value only applies to new claims. Otherwise the value, omitted
when it's "default" (the cluster's default class). Renders the whole `storageClassName:` line, or nothing.
Usage: include "rapidmx.pvcStorageClass" (dict "name" $claimName "value" .Values.mail.dkim.storage.storageClassName "context" $)
*/}}
{{- define "rapidmx.pvcStorageClass" -}}
{{-   $existing := (lookup "v1" "PersistentVolumeClaim" .context.Release.Namespace .name) | default dict -}}
{{-   $existingClass := dig "spec" "storageClassName" "" $existing -}}
{{-   $class := tpl (.value | default "") .context -}}
{{-   if $existingClass -}}
storageClassName: {{ $existingClass | quote }}
{{-   else if and $class (ne $class "default") -}}
storageClassName: {{ $class | quote }}
{{-   end -}}
{{- end -}}

{{/*********************************** COTURN ***********************************/}}

{{/* "true" when the bundled coturn is on (coturn.create). Usage: include "rapidmx.coturnEnabled" . */}}
{{- define "rapidmx.coturnEnabled" -}}
{{-   if and .Values.coturn .Values.coturn.create -}}
true
{{-   end -}}
{{- end -}}

{{/* The name browsers reach coturn at: coturn.hostname, else this chart's host. */}}
{{- define "rapidmx.coturnHost" -}}
{{-   include "rrst.render" (dict "value" (.Values.coturn.hostname | default .Values.host) "context" .) -}}
{{- end -}}

{{/*
The TURN URL the Video Conferencing plugin hands to browsers (mail:videoconf:turn:url), or empty when coturn is off: the UDP/TCP
address, and with coturn.tls.enabled the TLS one after it, separated by a comma. Usage: include "rapidmx.coturnURL" .
*/}}
{{- define "rapidmx.coturnURL" -}}
{{-   if eq (include "rapidmx.coturnEnabled" .) "true" -}}
{{-     $host := include "rapidmx.coturnHost" . -}}
{{-     if .Values.coturn.tls.enabled -}}
{{-       printf "turn:%s:%d,turns:%s:%d" $host (int .Values.coturn.port) $host (int .Values.coturn.tls.port) -}}
{{-     else -}}
{{-       printf "turn:%s:%d" $host (int .Values.coturn.port) -}}
{{-     end -}}
{{-   end -}}
{{- end -}}

{{/* The Secret holding coturn's credentials: coturn.auth.existingSecret, else the one this chart renders. */}}
{{- define "rapidmx.coturnSecretName" -}}
{{-   .Values.coturn.auth.existingSecret | default (printf "%s-coturn" (include "rrst.fullname" .)) -}}
{{- end -}}

{{/* How coturn authenticates its users: "secret" (a credential per join) or "credential" (one user name and password). */}}
{{- define "rapidmx.coturnAuthMode" -}}
{{-   $mode := toString .Values.coturn.auth.mode -}}
{{-   if not (has $mode (list "secret" "credential")) -}}
{{-     fail (printf "coturn.auth.mode is %q - it must be \"secret\" or \"credential\"." $mode) -}}
{{-   end -}}
{{-   $mode -}}
{{- end -}}

{{/*
The kubernetes.io/tls Secret coturn's TLS listener reads its certificate and key from: coturn.tls.existingSecret, else the
one cert-manager keeps for this chart's own host (tls-certs.yaml).
*/}}
{{- define "rapidmx.coturnTLSSecretName" -}}
{{-   .Values.coturn.tls.existingSecret | default (printf "%s-tls-cert" (include "rrst.render" (dict "value" .Values.host "context" .))) -}}
{{- end -}}

{{/*
Fails the render on a coturn setting that would leave it unable to start or unsafe to run. The secret, user name, password and
host end up in turnserver's command line, which its entrypoint passes through a shell, so they are limited to characters that
mean nothing to one. Usage: include "rapidmx.assertCoturn" $
*/}}
{{- define "rapidmx.assertCoturn" -}}
{{-   $c := .Values.coturn -}}
{{-   $mode := include "rapidmx.coturnAuthMode" . -}}
{{-   if and (eq $mode "credential") (not (regexMatch "^[A-Za-z0-9._-]+$" (toString $c.auth.username))) -}}
{{-     fail (printf "coturn.auth.username is %q - it may only contain letters, digits and . _ -" (toString $c.auth.username)) -}}
{{-   end -}}
{{-   if and $c.auth.password (not (regexMatch "^[A-Za-z0-9._~-]+$" (toString $c.auth.password))) -}}
{{-     fail "coturn.auth.password may only contain letters, digits and . _ ~ -" -}}
{{-   end -}}
{{-   if and $c.auth.sharedSecret (not (regexMatch "^[A-Za-z0-9._~-]+$" (toString $c.auth.sharedSecret))) -}}
{{-     fail "coturn.auth.sharedSecret may only contain letters, digits and . _ ~ -" -}}
{{-   end -}}
{{-   if not (regexMatch "^[A-Za-z0-9.-]+$" (include "rapidmx.coturnHost" .)) -}}
{{-     fail (printf "coturn.hostname resolves to %q - it must be a host name (letters, digits, . and -)." (include "rapidmx.coturnHost" .)) -}}
{{-   end -}}
{{-   if and $c.externalIp (not (regexMatch "^[0-9A-Fa-f:.]+$" (toString $c.externalIp))) -}}
{{-     fail (printf "coturn.externalIp is %q - it must be an IP address." (toString $c.externalIp)) -}}
{{-   end -}}
{{-   $min := int $c.relayPorts.min -}}
{{-   $max := int $c.relayPorts.max -}}
{{-   if or (lt $min 1024) (gt $max 65535) (gt $min $max) -}}
{{-     fail (printf "coturn.relayPorts is %d-%d - it must be a range of ports between 1024 and 65535, smallest first." $min $max) -}}
{{-   end -}}
{{-   $port := int $c.port -}}
{{-   if or (lt $port 1) (gt $port 65535) (and (ge $port $min) (le $port $max)) -}}
{{-     fail (printf "coturn.port is %d - it must be a port from 1 to 65535 outside the relay range %d-%d." $port $min $max) -}}
{{-   end -}}
{{-   if $c.tls.enabled -}}
{{-     $tlsPort := int $c.tls.port -}}
{{-     if or (lt $tlsPort 1) (gt $tlsPort 65535) (eq $tlsPort $port) (and (ge $tlsPort $min) (le $tlsPort $max)) -}}
{{-       fail (printf "coturn.tls.port is %d - it must be a port from 1 to 65535 that is neither coturn.port nor in the relay range %d-%d." $tlsPort $min $max) -}}
{{-     end -}}
{{-     if not $c.tls.existingSecret -}}
{{-       if ne (include "rapidmx.coturnHost" .) (include "rrst.render" (dict "value" .Values.host "context" .)) -}}
{{-         fail (printf "coturn.tls.enabled is true and coturn.hostname is %q, which is not this chart's host, so the certificate this chart issues does not cover it. Set coturn.tls.existingSecret to a kubernetes.io/tls Secret whose certificate does." (include "rapidmx.coturnHost" .)) -}}
{{-       end -}}
{{-       if ne (include "rrst.certificate" .) "true" -}}
{{-         fail "coturn.tls.enabled is true, but this chart issues no certificate for its host (global.gateway.tls is off, or the host is localhost or a .local name). Set coturn.tls.existingSecret to a kubernetes.io/tls Secret holding one." -}}
{{-       end -}}
{{-     end -}}
{{-   end -}}
{{- end -}}
