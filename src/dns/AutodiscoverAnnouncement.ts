///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import * as os from "node:os";
import { autodiscoverHostnameFor, resolveDnsPublisher, type DnsPublisher } from "@rapidmx/restapi";
import { ConnectionManager, type ObjectFactory } from "@rapidrest/service-core";

/** The Redis key (on the `cache` datastore) a server copy remembers the Autodiscover state it announced under: this prefix and the copy's instance id. */
export const AUTODISCOVER_STATE_PREFIX = "rapidmx:dns:autodiscover:";

/** How long a copy's record is kept. A copy that outlives it (or a record lost with Redis) only announces once more, which costs the controller one fetch. */
const STATE_TTL_SECONDS = 30 * 86_400;

/**
 * How long after an announcement a copy announces once more (two minutes). A Deployment rolled over a changed `mail:autodiscover:public_url` starts its new pods
 * while old pods still answer the Service: the controller woken by a new pod's announcement may be served by an old pod and read the old records, and nothing
 * else would announce afterwards. The second announcement comes after the rollout has moved on, and costs the controller one more fetch.
 */
export const DEFAULT_SETTLE_MS = 120_000;

/** The part of a node-redis client this uses. */
export interface AutodiscoverStateStore {
    get(key: string): Promise<string | null>;
    set(key: string, value: string, options: { EX: number }): Promise<unknown>;
}

export interface AutodiscoverAnnouncement {
    publisher: DnsPublisher;
    /** Where the copy remembers what it announced; without it every start announces. */
    redis?: AutodiscoverStateStore;
    /** This copy's identity, the plugin host's: `system:plugins:instance_id` or the host name (the pod name). */
    copy: string;
    /** `mail:autodiscover:public_url`. */
    publicUrl: string;
    logger?: { warn(message: string): void };
}

/**
 * What the Autodiscover records depend on, for one string: `off` while the Autodiscover plugin isn't loaded (no records at all), else `on:` and the host of
 * `mail:autodiscover:public_url` (empty while that isn't a valid URL, when both records are published as manual). It is what `autodiscoverHostnameFor()`
 * gives the desired state, so a change of it is a change of the records.
 */
export function autodiscoverFingerprint(publicUrl: string): string {
    const host: string | undefined = autodiscoverHostnameFor(publicUrl);
    return host === undefined ? "off" : `on:${host}`;
}

/**
 * Announces that the Autodiscover records changed, when this server copy runs with a state it hasn't announced yet (spec 7.3: "Autodiscover plugin
 * enabled/disabled", and, as the same records depend on it, a changed `mail:autodiscover:public_url`). Enabling or disabling the plugin takes effect only when
 * the plugin host restarts the copies, one at a time, and each copy computes the desired state from the plugins it has loaded, so every copy remembers, under its
 * own key, what it last announced and announces `all` when it starts into another state. The last copy to restart is therefore heard after every copy answers
 * with the new state, which one record shared by all the copies could not promise. A restart into the same state (another plugin changed) announces nothing.
 *
 * That holds for the plugin host's restarts, which are in-process and one at a time. A rolled Deployment (a changed public URL arrives that way) starts new pods
 * while old ones still serve, so `startDnsPublishing()` announces a second time after `DEFAULT_SETTLE_MS`; a rollout slower than that, or one that fails, is
 * left to the controller's periodic resync.
 *
 * Never throws: an announcement that fails is logged and not recorded, so the next start tries again, and the controller's periodic resync covers the meantime.
 *
 * @returns Whether a change was announced.
 */
export async function announceAutodiscoverState(options: AutodiscoverAnnouncement): Promise<boolean> {
    const fingerprint: string = autodiscoverFingerprint(options.publicUrl);
    const key: string = `${AUTODISCOVER_STATE_PREFIX}${options.copy}`;
    if (options.redis) {
        try {
            if ((await options.redis.get(key)) === fingerprint) {
                return false;
            }
        } catch (err: any) {
            // What was announced before is unknown: announcing again costs the controller one fetch.
            options.logger?.warn(`The Autodiscover state this server copy last announced could not be read (${err?.message}); announcing it again.`);
        }
    }
    try {
        await options.publisher.changed({ scope: "all" });
    } catch (err: any) {
        options.logger?.warn(`The Autodiscover state could not be announced to the DNS controller (${err?.message}); it picks it up at its next resync.`);
        return false;
    }
    try {
        await options.redis?.set(key, fingerprint, { EX: STATE_TTL_SECONDS });
    } catch (err: any) {
        options.logger?.warn(`The Autodiscover state this server copy announced could not be recorded (${err?.message}); it announces it again at its next start.`);
    }
    return true;
}

/**
 * Announces the Autodiscover state this server copy started with, once the plugin host has loaded the plugins (they decide it). Called by the worker after
 * `pluginHost.start()`; it needs the `DnsPublisher` the server registered (restapi's `NullDnsPublisher` stands in for none) and the `cache` Redis, when there is
 * one, to remember the announcement in. Never throws: a server whose announcement fails still starts.
 *
 * @param objectFactory The server's `ObjectFactory`.
 * @param config The loaded runtime configuration: `mail:autodiscover:public_url` and the plugin host's `system:plugins:instance_id`.
 * @param logger Where a failure is said.
 * @param settleMs How long after an announcement the same copy announces once more (`DEFAULT_SETTLE_MS`).
 */
export async function startDnsPublishing(
    objectFactory: Pick<ObjectFactory, "newInstance" | "getInstance">,
    config: { get(key: string): unknown },
    logger: { warn(message: string): void },
    settleMs: number = DEFAULT_SETTLE_MS,
): Promise<void> {
    try {
        const connections: Map<string, any> | undefined = objectFactory.getInstance<ConnectionManager>(ConnectionManager)?.connections;
        const publisher: DnsPublisher = await resolveDnsPublisher(objectFactory, logger);
        const announced: boolean = await announceAutodiscoverState({
            publisher,
            redis: connections?.get("cache"),
            copy: String(config.get("system:plugins:instance_id") || os.hostname()),
            publicUrl: String(config.get("mail:autodiscover:public_url") ?? ""),
            logger,
        });
        if (announced) {
            // The timer doesn't keep a stopping process alive.
            setTimeout(() => {
                publisher.changed({ scope: "all" }).catch((err: any) => {
                    logger.warn(`The Autodiscover state could not be announced again to the DNS controller (${err?.message}); it picks it up at its next resync.`);
                });
            }, settleMs).unref();
        }
    } catch (err: any) {
        logger.warn(`The Autodiscover state could not be announced to the DNS controller (${err?.message}); it picks it up at its next resync.`);
    }
}
