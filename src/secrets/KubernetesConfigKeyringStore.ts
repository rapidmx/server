///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ObjectDecorators } from "@rapidrest/core";
import {
    ConfigKeyringConflictError,
    ConfigKeyringInvalidError,
    parseConfigKeyring,
    serializeConfigKeyring,
    type ConfigKeyring,
    type ConfigKeyringSnapshot,
    type ConfigKeyringStore,
} from "@rapidmx/restapi";
import { KubeClient, KubeError } from "../diagnostics/KubeClient.js";
const { Config } = ObjectDecorators;

/** The key of the keyring in the Secret: the chart renders it, and the pods mount it as the file `keyring.json`. */
export const KEYRING_SECRET_KEY = "keyring.json";

export interface KubernetesConfigKeyringStoreOptions {
    /** The Secret to read and replace; `config_encryption:keyring_store:secret_name` when not given. */
    secretName?: string;
    /** The Kubernetes client; the pod's own service account when not given. */
    kube?: KubeClient;
    /** The process environment, which says whether this is a pod. */
    env?: NodeJS.ProcessEnv;
}

/**
 * Where a deployment without OpenBao keeps its configuration keyring (spec 5.3, 5.5): the Secret `<fullname>-config-keyring`, which the chart renders once and
 * the server's key rotation changes from then on. It is the server's one write to the Kubernetes API, and its Role (`configEncryption.rbac.create`) allows
 * `get` and `update` on that Secret by `resourceNames` and nothing else, so this reads and replaces that one object and touches no other.
 *
 * The version is the Secret's `resourceVersion`. `write()` reads the Secret again, so the rest of it (other keys, labels, annotations, the owner) is carried
 * over, refuses with a `ConfigKeyringConflictError` when the version is no longer the stored one, and puts the new ring with that version in the PUT, which the API
 * server checks again: a writer that gets in between is a 409, never an overwrite. Errors name the host, path and status, never the keyring.
 *
 * The server registers it under the DI token `"ConfigKeyringStore"` when `config_encryption:keyring_store:backend` is `kubernetes`.
 */
export class KubernetesConfigKeyringStore implements ConfigKeyringStore {
    @Config("config_encryption:keyring_store:secret_name", "")
    private configuredSecretName: string = "";

    private kube?: KubeClient;

    constructor(private readonly options: KubernetesConfigKeyringStoreOptions = {}) {
        this.kube = options.kube;
    }

    private secretName(): string {
        const name: string = (this.options.secretName ?? this.configuredSecretName ?? "").trim();
        if (!name) {
            throw new Error("config_encryption:keyring_store:secret_name isn't set, so the keyring Secret can't be read or changed.");
        }
        return name;
    }

    /** The client for this pod's service account, or why there is none (outside Kubernetes, no token mounted). */
    private async client(): Promise<KubeClient> {
        if (!this.kube) {
            const { client, reason } = await KubeClient.detect({ env: this.options.env });
            if (!client) {
                throw new Error(reason);
            }
            this.kube = client;
        }
        return this.kube;
    }

    private async path(): Promise<string> {
        const name: string = this.secretName();
        return `/api/v1/namespaces/${encodeURIComponent(await (await this.client()).namespace())}/secrets/${encodeURIComponent(name)}`;
    }

    public async read(): Promise<ConfigKeyringSnapshot> {
        const secret: any = await (await this.client()).get<any>(await this.path());
        return { keyring: this.keyringOf(secret), version: this.versionOf(secret) };
    }

    public async write(keyring: ConfigKeyring, version: string): Promise<void> {
        let text: string;
        try {
            text = serializeConfigKeyring(parseConfigKeyring(keyring));
        } catch (err: any) {
            throw new ConfigKeyringInvalidError(`The keyring to write isn't usable: ${err.message}`);
        }
        const client: KubeClient = await this.client();
        const path: string = await this.path();
        const current: any = await client.get<any>(path);
        if (this.versionOf(current) !== version) {
            throw new ConfigKeyringConflictError();
        }
        // The Secret as it is, with the new ring in place of the old one. managedFields is the API server's own bookkeeping, not ours to send back.
        const { managedFields: _managedFields, ...metadata } = current.metadata;
        const replacement = {
            apiVersion: "v1",
            kind: "Secret",
            metadata: { ...metadata, resourceVersion: version },
            ...(current.type ? { type: current.type } : {}),
            data: { ...current.data, [KEYRING_SECRET_KEY]: Buffer.from(text, "utf-8").toString("base64") },
        };
        try {
            await client.put(path, replacement);
        } catch (err: any) {
            if (err instanceof KubeError && err.status === 409) {
                throw new ConfigKeyringConflictError();
            }
            throw err;
        }
    }

    private versionOf(secret: any): string {
        const version: unknown = secret?.metadata?.resourceVersion;
        if (typeof version !== "string" || version === "") {
            throw new Error("The keyring Secret has no resourceVersion.");
        }
        return version;
    }

    /** The ring in the Secret's `keyring.json`; a Secret without one, or with one that isn't a keyring, is invalid. */
    private keyringOf(secret: any): ConfigKeyring {
        const encoded: unknown = secret?.data?.[KEYRING_SECRET_KEY];
        if (typeof encoded !== "string" || encoded === "") {
            throw new ConfigKeyringInvalidError(`The keyring Secret has no ${KEYRING_SECRET_KEY}.`);
        }
        if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
            throw new ConfigKeyringInvalidError(`The ${KEYRING_SECRET_KEY} of the keyring Secret isn't base64.`);
        }
        try {
            return parseConfigKeyring(Buffer.from(encoded, "base64").toString("utf-8"));
        } catch (err: any) {
            throw new ConfigKeyringInvalidError(`The ${KEYRING_SECRET_KEY} of the keyring Secret isn't a usable keyring: ${err.message}`);
        }
    }
}
