///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import * as os from "os";
import { EventUtils, JWTUtils } from "@rapidrest/core";

interface TelemetryConfig {
    get(key: string): any;
}

const DEFAULT_TTL_SECONDS: number = 3_600;

/** How long the telemetry token is valid for (`telemetry_services:token_ttl_seconds`, at least 60 seconds). */
export function telemetryTokenTtlSeconds(config: TelemetryConfig): number {
    const ttl: number = Number(config.get("telemetry_services:token_ttl_seconds"));
    return Number.isFinite(ttl) && ttl >= 60 ? Math.floor(ttl) : DEFAULT_TTL_SECONDS;
}

/**
 * Creates the token this server sends telemetry events with. It expires after `telemetry_services:token_ttl_seconds`
 * and carries only `telemetry_services:token_roles` (default `["telemetry"]`) - never `trusted_roles`, so a leaked
 * token can't be used as an administrator.
 *
 * Builds a standalone copy of the auth config rather than mutating the object `config.get()` returns: nconf does not
 * clone nested values, so changing it in place would change every other consumer's view of `auth` too.
 */
export async function createTelemetryToken(config: TelemetryConfig): Promise<string> {
    const configuredAuth: any = config.get("auth");
    const auth: any = {
        ...configuredAuth,
        options: { ...configuredAuth?.options, expiresIn: telemetryTokenTtlSeconds(config) },
    };
    const roles: unknown = config.get("telemetry_services:token_roles");
    return await JWTUtils.createToken(auth, {
        uid: `${config.get("service_name")}-${os.hostname()}`,
        roles: Array.isArray(roles) ? roles : ["telemetry"],
        scopes: [],
    });
}

/**
 * Initializes `EventUtils` with a telemetry token and replaces it with a fresh one at half its lifetime, so it never
 * expires while the server runs. Call `stop()` on shutdown.
 */
export async function startTelemetryToken(config: TelemetryConfig, logger: any): Promise<{ stop: () => void }> {
    await EventUtils.init(config, logger, await createTelemetryToken(config));
    const timer: NodeJS.Timeout = setInterval(() => {
        createTelemetryToken(config)
            .then((token: string) => {
                // EventUtils has no setter and init() would drop registered listeners; the token is all that changes.
                (EventUtils as any).token = token;
            })
            .catch((err: any) => logger?.warn?.(`Could not renew the telemetry token: ${err?.message ?? err}`));
    }, (telemetryTokenTtlSeconds(config) * 1000) / 2);
    timer.unref?.();
    return { stop: () => clearInterval(timer) };
}
