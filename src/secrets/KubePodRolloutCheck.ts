///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ObjectDecorators } from "@rapidrest/core";
import type { RolloutStatus, ServerRolloutCheck } from "@rapidmx/restapi";
import { KubeClient } from "../diagnostics/KubeClient.js";
const { Config } = ObjectDecorators;

/** The label every ReplicaSet puts on its pods: two pods have it equal when they run the same pod template, i.e. the same release. */
const POD_TEMPLATE_HASH = "pod-template-hash";

/** How many pods of an older release the reason names before it counts the rest. */
const MAX_NAMED_PODS = 10;

export interface KubePodRolloutCheckOptions {
    /** The label selector of the server Deployment's pods; `config_encryption:plugin_secrets:pod_selector` when not given. */
    selector?: string;
    /** The Kubernetes client; the pod's own service account when not given. */
    kube?: KubeClient;
    /** The process environment: `KUBERNETES_SERVICE_HOST` says whether this is a pod, `HOSTNAME` which one. */
    env?: NodeJS.ProcessEnv;
    /** Where the service account is mounted; the standard path when not given. */
    serviceAccountDir?: string;
}

/**
 * Whether the server's rolling upgrade has finished (spec 5.7), for `PluginSecretEncryptor`, which encrypts plugin secret settings only once no pod of the
 * previous release is left (such a pod applies `Plugin.settings` raw and would hand a plugin an envelope as a value). It reads only pods, through the `get`
 * and `list` on `pods` the Diagnostics Role already grants: this pod (`HOSTNAME`), for its `pod-template-hash`, and the pods matching the Deployment's
 * selector (`config_encryption:plugin_secrets:pod_selector`, which the chart renders from the server Deployment's selector labels). It is rolled out when every
 * one of those pods - a terminating one included, since it still runs - carries this pod's hash, i.e. no pod of an older ReplicaSet is left. A pod that has
 * finished (`Succeeded` or `Failed`, such as an evicted old one, which Kubernetes keeps listed) runs nothing and isn't waited for.
 *
 * Outside Kubernetes (`KUBERNETES_SERVICE_HOST` unset: `yarn dev`, docker-compose) there is no rolling upgrade, so it answers "rolled out" at once. Where it can't
 * tell - no token mounted, the pods can't be listed (the Diagnostics Role turned off), no selector - it rejects, and the encryptor waits and logs it once.
 *
 * The server registers it under the DI token `"ServerRolloutCheck"`.
 */
export class KubePodRolloutCheck implements ServerRolloutCheck {
    @Config("config_encryption:plugin_secrets:pod_selector", "")
    private configuredSelector: string = "";

    private kube?: KubeClient;

    constructor(private readonly options: KubePodRolloutCheckOptions = {}) {
        this.kube = options.kube;
    }

    public async check(): Promise<RolloutStatus> {
        const env: NodeJS.ProcessEnv = this.options.env ?? process.env;
        if (!env.KUBERNETES_SERVICE_HOST) {
            return { rolledOut: true };
        }
        const client: KubeClient = await this.client(env);
        const selector: string = (this.options.selector ?? this.configuredSelector ?? "").trim();
        if (!selector) {
            throw new Error("config_encryption:plugin_secrets:pod_selector isn't set, so the server's pods can't be listed.");
        }
        const hostname: string = (env.HOSTNAME ?? "").trim();
        if (!hostname) {
            throw new Error("HOSTNAME isn't set, so this pod can't be found among the server's pods.");
        }
        const namespace: string = encodeURIComponent(await client.namespace());

        const own: any = await client.get<any>(`/api/v1/namespaces/${namespace}/pods/${encodeURIComponent(hostname)}`);
        const hash: unknown = own?.metadata?.labels?.[POD_TEMPLATE_HASH];
        if (typeof hash !== "string" || hash === "") {
            throw new Error(`This pod has no ${POD_TEMPLATE_HASH} label, so the pods of an older release can't be told apart.`);
        }
        const list: any = await client.get<any>(`/api/v1/namespaces/${namespace}/pods?labelSelector=${encodeURIComponent(selector)}`);
        const older: string[] = ((list?.items ?? []) as any[])
            .filter((pod) => pod?.status?.phase !== "Succeeded" && pod?.status?.phase !== "Failed")
            .filter((pod) => pod?.metadata?.labels?.[POD_TEMPLATE_HASH] !== hash)
            .map((pod) => String(pod?.metadata?.name ?? "(unnamed)"));
        if (older.length === 0) {
            return { rolledOut: true };
        }
        const named: string = older.slice(0, MAX_NAMED_PODS).join(", ") + (older.length > MAX_NAMED_PODS ? `, and ${older.length - MAX_NAMED_PODS} more` : "");
        return { rolledOut: false, reason: `Pods of an older release are still running: ${named}.` };
    }

    private async client(env: NodeJS.ProcessEnv): Promise<KubeClient> {
        if (!this.kube) {
            const { client, reason } = await KubeClient.detect({ env, serviceAccountDir: this.options.serviceAccountDir });
            if (!client) {
                throw new Error(reason);
            }
            this.kube = client;
        }
        return this.kube;
    }
}
