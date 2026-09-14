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
"true" when the Gateway terminates TLS for .Values.host: gateway.tls is on and the host can get a real certificate
(tls-certs.yaml only issues one for a host that isn't localhost or *.local). Empty otherwise.
*/}}
{{- define "server.tlsEnabled" -}}
{{- if and .Values.gateway.tls (ne .Values.host "localhost") (not (contains ".local" .Values.host)) -}}
true
{{- end -}}
{{- end -}}

{{/* The public base URL of this deployment, e.g. https://mail.example.com. */}}
{{- define "server.publicUrl" -}}
{{- printf "%s://%s" (ternary "https" "http" (eq (include "server.tlsEnabled" .) "true")) .Values.host -}}
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
