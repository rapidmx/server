///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import type { IntegrationSettings } from "@rapidmx/restapi";
import type { IntegrationsChannel, IntegrationsListenerStop } from "./IntegrationsChannel.js";
import type { IntegrationsLayer } from "./IntegrationsLayer.js";

/** How often a copy compares the row's version, whatever it has heard: a notice published while it was reconnecting is gone (restapi spec 11.2, "within a minute"). */
export const DEFAULT_INTEGRATIONS_POLL_MS = 60_000;

export interface IntegrationsSyncOptions {
    layer: IntegrationsLayer;
    /** Reads the `IntegrationSettings` row (none before an administrator changed anything). */
    read: () => Promise<IntegrationSettings | undefined>;
    /** Where the change notice is heard. Without one the copy follows the row on its timer alone. */
    channel?: IntegrationsChannel;
    logger?: { warn(message: string): void };
    /** How often the row's version is compared (default one minute). */
    pollMs?: number;
}

/**
 * Keeps this copy's integrations layer current (restapi spec 11.2): the layer is rebuilt from the row when `rapidmx:integrations:changed` is heard, and a timer
 * compares the row's version so a copy that missed a notice catches up within a minute. Every consumer reads the layer at use time (`HostConfig`), so a rebuilt
 * layer is a change applied: no restart, and nothing else to tell.
 *
 * Reading is one lookup of one row by its identifier, once a minute per copy, and decryption only happens when the version moved (or while a secret can't be
 * read, so a key the keyring gains later is used without a change to the row): never per request (spec 5.4). A failure, to read the row or to hear the notice,
 * leaves the layer as it is and is said once for as long as it repeats.
 */
export class IntegrationsSync {
    private readonly pollMs: number;
    private timer?: NodeJS.Timeout;
    private running?: Promise<void>;
    private again: boolean = false;
    private stopped: boolean = false;
    private stopListening?: IntegrationsListenerStop;
    private subscribing?: Promise<void>;
    private lastReadError?: string;
    private lastListenError?: string;

    constructor(private readonly options: IntegrationsSyncOptions) {
        this.pollMs = options.pollMs ?? DEFAULT_INTEGRATIONS_POLL_MS;
    }

    /**
     * Applies the row now, starts the timer and starts listening for the notice. Never rejects: the server must start whatever the datastores are doing. The
     * listening is not waited for: a subscriber connection to a Redis that can't be reached keeps retrying and never settles, and the timer, which is what
     * covers a notice that can't be heard, must not wait on it.
     */
    public async start(): Promise<void> {
        this.stopped = false;
        await this.refresh();
        this.timer = setInterval(() => {
            void this.refresh();
            void this.listen();
        }, this.pollMs);
        this.timer.unref();
        void this.listen();
    }

    /**
     * Reads the row and rebuilds the layer when its version moved. One at a time: a call made while one is running waits for it, and makes it read once more
     * (the change it was asked about may have landed after that read).
     */
    public refresh(): Promise<void> {
        if (this.running) {
            this.again = true;
            return this.running;
        }
        const running: Promise<void> = (async () => {
            do {
                this.again = false;
                await this.refreshOnce();
            } while (this.again && !this.stopped);
        })().finally(() => {
            this.running = undefined;
        });
        this.running = running;
        return running;
    }

    private async refreshOnce(): Promise<void> {
        const { layer } = this.options;
        try {
            const settings: IntegrationSettings | undefined = await this.options.read();
            if ((settings?.version ?? 0) !== layer.version || layer.unreadable.length > 0) {
                layer.apply(settings);
            }
            this.lastReadError = undefined;
        } catch (err: any) {
            // The layer stays as it was. The same failure every minute is one line.
            const message: string = String(err?.message ?? err);
            if (message !== this.lastReadError) {
                this.lastReadError = message;
                this.options.logger?.warn(`The integrations could not be refreshed, so the layer is as it was (${message}); the next attempt is within a minute.`);
            }
        }
    }

    /** Starts hearing the notice, if it isn't heard yet; a failure is said once and tried again on the next tick. */
    private listen(): Promise<void> {
        const { channel } = this.options;
        if (!channel || this.stopListening || this.stopped) {
            return Promise.resolve();
        }
        this.subscribing ??= channel
            .subscribe(() => void this.refresh())
            .then(
                (stop) => {
                    // Stopped while subscribing: don't leave the connection open.
                    if (this.stopped) {
                        return stop();
                    }
                    this.stopListening = stop;
                    this.lastListenError = undefined;
                },
                (err: any) => {
                    const message: string = String(err?.message ?? err);
                    if (message !== this.lastListenError) {
                        this.lastListenError = message;
                        this.options.logger?.warn(`The integrations change notice can't be heard (${message}); this copy follows the integrations on its timer instead.`);
                    }
                },
            )
            .finally(() => {
                this.subscribing = undefined;
            });
        return this.subscribing;
    }

    /** Stops the timer and the listening, and waits for a refresh in progress. Safe to call again. */
    public async stop(): Promise<void> {
        this.stopped = true;
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
        // A subscription still being made is not waited for (it may never settle): it closes itself when it does.
        const stop: IntegrationsListenerStop | undefined = this.stopListening;
        this.stopListening = undefined;
        await stop?.().catch(() => undefined);
        await this.running;
    }
}
