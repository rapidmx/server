///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ApiError, ObjectDecorators, type JWTUser } from "@rapidrest/core";
import { ApiErrorMessages, ApiErrors, ConnectionManager, HttpRequest, RouteDecorators } from "@rapidrest/service-core";
import {
    recordAuditLog,
    type AddPluginRequest,
    type AddPluginResponse,
    type AuditAction,
    type Plugin,
    type PluginPlanResponse,
    type PluginStatusResponse,
} from "@rapidmx/restapi";
import { blockingInstances } from "../plugins/PluginPurgeCoordination.js";
import { PluginPurgeLedger, PurgeInProgressError } from "../plugins/PluginPurgeLedger.js";
import { PluginPurgeStore } from "../plugins/PluginPurgeStore.js";
import { getPluginPurger, PURGE_AUDIT } from "../plugins/PluginPurger.js";
import type { PluginPurgeInfo, PluginPurgeRecord } from "../plugins/PluginPurgeTypes.js";

const { Config, Logger } = ObjectDecorators;
const { Delete, Get, Param, Post, Request, RequiresTrustedRole, User: AuthUser } = RouteDecorators;

/** The response of `DELETE /:id`. Older clients ignore it (they never sent `purgeData`). */
export interface RemovePluginResponse {
    /** Whether the plugin's data will be deleted once no server copy runs the plugin any more. */
    purgeScheduled: boolean;
    /** Where that deletion stands (`pending` right after the uninstall unless nothing runs the plugin). */
    purge?: PluginPurgeInfo;
}

/** `POST /` also tells an administrator when adding a plugin ended the deletion of its data that was waiting. */
export interface AddPluginPurgeResponse<T extends Plugin = Plugin> extends AddPluginResponse<T> {
    /** The plugins (the one added, and any it required) whose pending data deletion was cancelled by adding them. */
    purgeCancelled?: string[];
    warnings?: string[];
}

/** `GET /status` with where each uninstalled plugin's data deletion stands. */
export interface PluginPurgeStatusResponse extends PluginStatusResponse {
    purges: PluginPurgeInfo[];
}

/** The uninstall's `purgeData` flag: `true` only when the JSON body (or the query string, for a client or proxy that
 * can't send a `DELETE` body) says so; absent means `false`. */
export function parsePurgeData(req: { body?: unknown; query?: Record<string, unknown> }): boolean {
    const body: any = req.body;
    let value: unknown = body && typeof body === "object" && !Buffer.isBuffer(body) ? body.purgeData : undefined;
    if (value === undefined && req.query?.purgeData !== undefined) {
        const query: unknown = req.query.purgeData;
        value = query === "true" ? true : query === "false" ? false : query;
    }
    if (value === undefined) {
        return false;
    }
    if (typeof value !== "boolean") {
        throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "'purgeData' must be true or false.");
    }
    return value;
}

/** Deleting data is destructive and can't be undone, so it takes a caller whose token is elevated (recently confirmed
 * their identity), on top of the trusted role every plugin endpoint needs. */
export function requireElevation(req: { user?: JWTUser }, user?: JWTUser): void {
    const elevated: number | undefined = user?.elevated ?? req.user?.elevated;
    if (!(typeof elevated === "number" && elevated > 0)) {
        throw new ApiError(ApiErrors.AUTH_REQUIRES_ELEVATION, 403, ApiErrorMessages.AUTH_REQUIRES_ELEVATION);
    }
}

/** A purge record as `GET /status` reports it. */
export function toPurgeInfo(record: PluginPurgeRecord, status?: Pick<PluginStatusResponse, "hash" | "instances">, now: number = Date.now()): PluginPurgeInfo {
    const info: PluginPurgeInfo = {
        uid: record.uid,
        name: record.name,
        displayName: record.displayName,
        state: record.state as PluginPurgeInfo["state"],
        requestedBy: record.requestedBy,
        requestedAt: record.requestedAt?.toISOString(),
        completedAt: record.completedAt?.toISOString(),
        steps: record.steps,
        error: record.error,
    };
    if (record.state === "pending" && status) {
        const { blocking, total } = blockingInstances(status.instances, record.name, status.hash, now);
        info.serversRunning = blocking.length;
        info.serversTotal = total;
    }
    return info;
}

/** What the mixin uses of restapi's `BasePluginRoute` (both datastores' routes have it). */
interface PluginRouteBase {
    list(): Promise<Plugin[]>;
    status(): Promise<PluginStatusResponse>;
    remove(id: string, req: HttpRequest, user?: JWTUser): Promise<unknown>;
    add(obj: AddPluginRequest | undefined, req: HttpRequest, user?: JWTUser): Promise<AddPluginResponse<Plugin>>;
    plan(name?: unknown, packageVersion?: unknown): Promise<PluginPlanResponse>;
}

type RouteBase = new (...args: any[]) => PluginRouteBase;

/**
 * Adds uninstalling a plugin *with its data* to restapi's plugin route, for one datastore:
 *
 * `DELETE /:id` takes `{ "purgeData": true }` (or `?purgeData=true`). Only an elevated caller may set it; the request is
 * audited; the plugin is uninstalled exactly as before, and its data deletion is recorded as pending for the servers
 * (`PluginPurger`) to run once none runs the plugin. Without the flag nothing changes.
 *
 * `POST /` cancels a pending deletion of the plugin (and of any plugin it requires) being added again, and refuses
 * while one is running.
 *
 * `GET /status` also lists each uninstalled plugin's deletion (`purges`).
 *
 * `POST /purges/:uid/retry` re-runs a failed deletion's failed steps.
 */
export function withPluginPurge<B extends RouteBase>(Base: B, binding: { datastore: string; purgeClass: any }) {
    class PurgingPluginRoute extends Base {
        @Config()
        public purgeConfig: any;

        @Logger
        public purgeLogger: any;

        /** Set directly by tests; otherwise built from the server's own connection. */
        public purgeLedger?: PluginPurgeLedger;

        public getPurgeLedger(): PluginPurgeLedger {
            if (!this.purgeLedger) {
                const connections = ((this as any)._objectFactory.getInstance(ConnectionManager) as ConnectionManager).connections;
                this.purgeLedger = new PluginPurgeLedger(new PluginPurgeStore(connections.get(binding.datastore), binding.purgeClass));
            }
            return this.purgeLedger;
        }

        private async purgeAudit(req: HttpRequest, user: JWTUser | undefined, action: string, plugin: { uid: string; name: string }, details: Record<string, unknown>): Promise<void> {
            await recordAuditLog(
                (this as any)._objectFactory,
                (this as any).auditLogClass,
                { config: this.purgeConfig, req, user, logger: this.purgeLogger },
                { action: action as AuditAction, targetType: "Plugin", targetUid: plugin.uid, details: { name: plugin.name, ...details } },
            );
        }

        /** Each uninstalled plugin's data deletion, without the plugins that are installed (again). */
        private async purgeInfos(status: PluginStatusResponse): Promise<PluginPurgeInfo[]> {
            try {
                const installed: Set<string> = new Set((await this.list()).map((plugin) => plugin.name));
                return (await this.getPurgeLedger().list())
                    .filter((record) => ["pending", "running", "done", "failed"].includes(record.state) && !installed.has(record.name))
                    .map((record) => toPurgeInfo(record, status))
                    .sort((a, b) => a.name.localeCompare(b.name));
            } catch (err: any) {
                // The plugin list itself doesn't depend on this.
                this.purgeLogger?.warn?.(`Could not read the plugin data deletions: ${err.message}`);
                return [];
            }
        }

        @RequiresTrustedRole()
        @Get("/status")
        public async status(): Promise<PluginPurgeStatusResponse> {
            const status: PluginStatusResponse = await super.status();
            return { ...status, purges: await this.purgeInfos(status) };
        }

        @RequiresTrustedRole()
        @Delete("/:id")
        public async remove(@Param("id") id: string, @Request req: HttpRequest, @AuthUser user?: JWTUser): Promise<RemovePluginResponse> {
            const purgeData: boolean = parsePurgeData(req);
            if (purgeData) {
                requireElevation(req, user);
            }
            const found: Plugin | undefined = (await this.list()).find((plugin) => plugin.uid === id);
            // As the plugin was before the uninstall changes its row.
            const existing: Plugin | undefined = found && { ...found, manifest: found.manifest };
            const ledger: PluginPurgeLedger = this.getPurgeLedger();
            if (purgeData && existing && !(await ledger.get(existing.name))?.inventory) {
                throw new ApiError(
                    ApiErrors.IDENTIFIER_EXISTS,
                    409,
                    `No server has recorded which data ${existing.manifest.displayName} stores, so it can't be deleted. Enable the plugin, wait for the servers to restart, then uninstall it again.`,
                );
            }

            // The uninstall itself is restapi's, unchanged (dependents check, undo, audit entry, announcement).
            await super.remove(id, req, user);
            if (!existing) {
                return { purgeScheduled: false };
            }
            if (!purgeData) {
                // What an earlier deletion of this plugin's data recorded no longer describes what is in the database.
                await ledger.clearOutcome(existing.name).catch(() => undefined);
                return { purgeScheduled: false };
            }

            const record: PluginPurgeRecord = await ledger.request(existing.name, {
                displayName: existing.manifest.displayName,
                packageVersion: existing.packageVersion,
                integrity: existing.integrity,
                requestedBy: user?.uid,
                wasEnabled: existing.enabled,
            });
            await this.purgeAudit(req, user, PURGE_AUDIT.requested, existing, {
                purgeData: true,
                packageVersion: existing.packageVersion,
                wasEnabled: existing.enabled,
            });
            getPluginPurger()?.kick();
            const status: PluginStatusResponse = await super.status().catch(() => ({ hash: "", instances: [] }));
            return { purgeScheduled: true, purge: toPurgeInfo(record, status) };
        }

        @RequiresTrustedRole()
        @Post()
        public async add(obj: AddPluginRequest | undefined, @Request req: HttpRequest, @AuthUser user?: JWTUser): Promise<AddPluginPurgeResponse> {
            const ledger: PluginPurgeLedger = this.getPurgeLedger();
            const cancelled: PluginPurgeRecord[] = [];
            try {
                const name: string = typeof obj?.name === "string" ? obj.name.trim() : "";
                const unfinished: PluginPurgeRecord[] = name ? await ledger.unfinished() : [];
                if (unfinished.length > 0) {
                    // Adding a plugin also revives the removed plugins it requires, so a deletion pending for any of them ends too.
                    let names: string[] = [name];
                    if (unfinished.some((record) => record.name !== name)) {
                        try {
                            names = [name, ...(await this.plan(name, obj?.packageVersion)).install.map((install) => install.name)];
                        } catch {
                            // The add reports whatever is wrong with it.
                        }
                    }
                    for (const record of unfinished.filter((candidate) => names.includes(candidate.name))) {
                        if ((await ledger.cancelPending(record.name)) === "cancelled") {
                            cancelled.push(record);
                        }
                    }
                }
                const result: AddPluginPurgeResponse = await super.add(obj, req, user);
                for (const record of cancelled) {
                    // Audited against the plugin's own row, which adding it revived.
                    const revived: Plugin | undefined = [result.plugin, ...(result.dependencies ?? [])].find((plugin) => plugin.name === record.name);
                    await this.purgeAudit(req, user, PURGE_AUDIT.cancelled, { uid: revived?.uid ?? record.uid, name: record.name }, { reason: "The plugin was added again." });
                }
                if (cancelled.length > 0) {
                    result.purgeCancelled = cancelled.map((record) => record.name);
                    result.warnings = cancelled.map(
                        (record) => `The pending deletion of ${record.displayName ?? record.name}'s data was cancelled because the plugin was added again. Its data is kept.`,
                    );
                }
                return result;
            } catch (err) {
                for (const record of cancelled) {
                    await ledger.uncancel(record.name).catch(() => undefined);
                }
                if (err instanceof PurgeInProgressError) {
                    throw new ApiError(ApiErrors.IDENTIFIER_EXISTS, 409, err.message);
                }
                throw err;
            }
        }

        @RequiresTrustedRole()
        @Post("/purges/:uid/retry")
        public async retryPurge(@Param("uid") uid: string, @Request req: HttpRequest, @AuthUser user?: JWTUser): Promise<PluginPurgeInfo> {
            requireElevation(req, user);
            const ledger: PluginPurgeLedger = this.getPurgeLedger();
            const record: PluginPurgeRecord | undefined = (await ledger.list()).find((candidate) => candidate.uid === uid);
            if (!record) {
                throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
            }
            if (record.state !== "failed") {
                throw new ApiError(ApiErrors.IDENTIFIER_EXISTS, 409, "Only a data deletion that failed can be retried.");
            }
            if (!(await ledger.retry(record.name))) {
                throw new ApiError(ApiErrors.IDENTIFIER_EXISTS, 409, "The data deletion changed while it was being retried. Reload and try again.");
            }
            await this.purgeAudit(req, user, PURGE_AUDIT.retried, record, { failedSteps: record.steps.filter((step) => !step.ok).map((step) => step.step) });
            getPluginPurger()?.kick();
            return toPurgeInfo((await ledger.get(record.name))!);
        }
    }
    return PurgingPluginRoute;
}
