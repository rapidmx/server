///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
import type { DiagnosticsComponentName } from "./types.js";

/** Container (or image) names the chart's pods use for each component; the Bitnami subcharts name theirs the same way. */
const NAMES: Record<string, DiagnosticsComponentName> = {
    postfix: "postfix",
    "postfix-bridge": "postfix-bridge",
    "mta-bridge": "postfix-bridge",
    mongodb: "mongodb",
    mongo: "mongodb",
    postgresql: "postgresql",
    postgres: "postgresql",
    redis: "redis",
    coturn: "coturn",
    rspamd: "rspamd",
    clamav: "clamav",
};

/** Sidecars that share a component's name in their own (`redis-exporter`, a `metrics` container) are not the component. */
const SIDECAR = /exporter|metrics/;

/** The last path segment of an image reference, without its tag or digest: `docker.io/clamav/clamav:stable` is `clamav`. */
export function imageBasename(image: string): string {
    const noDigest = image.split("@")[0];
    const last = noDigest.slice(noDigest.lastIndexOf("/") + 1);
    return last.split(":")[0];
}

/** Which component a container is, going by its name first (the chart names them after the component) and its image second. */
export function classifyContainer(name: string, image: string): DiagnosticsComponentName | undefined {
    const byName = NAMES[name];
    if (byName) {
        return byName;
    }
    if (SIDECAR.test(name)) {
        return undefined;
    }
    const base = imageBasename(image);
    return SIDECAR.test(base) ? undefined : NAMES[base];
}

/** The tag of an image reference (`repo:tag`, `repo:tag@sha256:...`), ignoring a registry's port; undefined for a bare digest. */
export function imageTag(image: string): string | undefined {
    const noDigest = image.split("@")[0];
    const last = noDigest.slice(noDigest.lastIndexOf("/") + 1);
    const colon = last.indexOf(":");
    return colon === -1 ? undefined : last.slice(colon + 1);
}

/** The `sha256:...` part of a container status's `imageID` (`docker.io/rspamd/rspamd@sha256:abc`, or a bare digest). */
export function imageDigest(imageID: string | undefined): string | undefined {
    const match = /sha256:[0-9a-f]{64}/.exec(imageID ?? "");
    return match?.[0];
}
