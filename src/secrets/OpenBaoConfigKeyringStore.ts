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
import { DEFAULT_OPENBAO_TOKEN_FILE, OpenBaoClient, OpenBaoError, openBaoClientOptions } from "../openbao/OpenBaoClient.js";
const { Config } = ObjectDecorators;

/** The property of the KV secret that holds the keyring's JSON: the installer creates it, and External Secrets syncs it into the Secret the pods mount. */
export const KEYRING_KV_PROPERTY = "keyring";

/** A KV v2 mount name (one path segment). */
const MOUNT_PATTERN: RegExp = /^[A-Za-z0-9_.-]+$/;
/** A KV path: segments of letters, digits, `_`, `.` and `-` joined by single slashes, none starting with a `.` (so no `.` or `..`). */
const PATH_PATTERN: RegExp = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*(\/[A-Za-z0-9_-][A-Za-z0-9_.-]*)*$/;

export interface OpenBaoConfigKeyringStoreOptions {
    /** The OpenBao client; the server's (`mail:pki:openbao:*`: its address, CA bundle and Kubernetes login) when not given. */
    client?: OpenBaoClient;
    /** The KV v2 mount; `config_encryption:keyring_store:kv_mount` when not given. */
    mount?: string;
    /** The KV path of the keyring secret; `config_encryption:keyring_store:kv_path` when not given. */
    path?: string;
}

/**
 * Where a deployment with OpenBao keeps its configuration keyring (spec 5.3, 5.5, 5.8): the KV v2 secret `<kv mount>/<fullname>/config-keyring`, property
 * `keyring`. The server's OpenBao role may read and update that path and its metadata and no other KV path, and the server holds no Kubernetes write right
 * in this setup: External Secrets syncs the KV secret into the Secret the pods mount.
 *
 * The version is the KV version. `write()` sends it as KV v2's check-and-set (`options.cas`), so OpenBao itself refuses (400) a write after the secret changed,
 * which is a `ConfigKeyringConflictError`, never an overwrite. The client is the server's `OpenBaoClient` (https to the in-cluster listener with the installer's
 * CA, a login with the pod's projected ServiceAccount token), built on first use from the `mail:pki:openbao` settings the chart sets. Errors name the path and
 * status, never the keyring.
 *
 * The server registers it under the DI token `"ConfigKeyringStore"` when `config_encryption:keyring_store:backend` is `openbao`.
 */
export class OpenBaoConfigKeyringStore implements ConfigKeyringStore {
    @Config("config_encryption:keyring_store:kv_mount", "secret")
    private configuredMount: string = "secret";

    @Config("config_encryption:keyring_store:kv_path", "")
    private configuredPath: string = "";

    @Config("mail:pki:openbao:address", "http://127.0.0.1:8200")
    private openBaoAddress: string = "http://127.0.0.1:8200";

    @Config("mail:pki:openbao:ca_file", "")
    private caFile: string = "";

    @Config("mail:pki:openbao:token", "")
    private staticToken: string = "";

    @Config("mail:pki:openbao:timeout_ms", 10_000)
    private openBaoTimeoutMs: number | string = 10_000;

    @Config("mail:pki:openbao:auth:method", "token")
    private authMethod: string = "token";

    @Config("mail:pki:openbao:auth:role", "")
    private authRole: string = "";

    @Config("mail:pki:openbao:auth:mount_path", "kubernetes")
    private authMountPath: string = "kubernetes";

    @Config("mail:pki:openbao:auth:token_file", DEFAULT_OPENBAO_TOKEN_FILE)
    private authTokenFile: string = DEFAULT_OPENBAO_TOKEN_FILE;

    private openBao?: OpenBaoClient;

    constructor(private readonly options: OpenBaoConfigKeyringStoreOptions = {}) {
        this.openBao = options.client;
    }

    /** Built on first use, from the configuration injected after construction. */
    private client(): OpenBaoClient {
        this.openBao ??= new OpenBaoClient(
            openBaoClientOptions("mail:pki:openbao", {
                address: this.openBaoAddress,
                ca_file: this.caFile,
                token: this.staticToken,
                timeout_ms: this.openBaoTimeoutMs,
                auth: { method: this.authMethod, role: this.authRole, mount_path: this.authMountPath, token_file: this.authTokenFile },
            }),
        );
        return this.openBao;
    }

    /** The API path of the secret's data, from settings that can't name any other secret. */
    private dataPath(): string {
        const mount: string = (this.options.mount ?? this.configuredMount ?? "").trim();
        const path: string = (this.options.path ?? this.configuredPath ?? "").trim();
        if (!MOUNT_PATTERN.test(mount) || mount === "." || mount === "..") {
            throw new Error("config_encryption:keyring_store:kv_mount must be the name of a KV mount.");
        }
        if (path === "") {
            throw new Error("config_encryption:keyring_store:kv_path isn't set, so the keyring can't be read or changed.");
        }
        if (!PATH_PATTERN.test(path)) {
            throw new Error("config_encryption:keyring_store:kv_path must be a path of names joined by single slashes, such as <fullname>/config-keyring.");
        }
        return `${mount}/data/${path}`;
    }

    public async read(): Promise<ConfigKeyringSnapshot> {
        const answer: any = await this.client().request<any>("GET", this.dataPath());
        const text: unknown = answer?.data?.data?.[KEYRING_KV_PROPERTY];
        const version: unknown = answer?.data?.metadata?.version;
        if (!Number.isInteger(version)) {
            throw new Error("OpenBao answered without the version of the keyring secret.");
        }
        if (typeof text !== "string" || text === "") {
            throw new ConfigKeyringInvalidError(`The keyring secret has no ${KEYRING_KV_PROPERTY} property.`);
        }
        try {
            return { keyring: parseConfigKeyring(text), version: String(version) };
        } catch (err: any) {
            throw new ConfigKeyringInvalidError(`The ${KEYRING_KV_PROPERTY} of the keyring secret isn't a usable keyring: ${err.message}`);
        }
    }

    public async write(keyring: ConfigKeyring, version: string): Promise<void> {
        let text: string;
        try {
            text = serializeConfigKeyring(parseConfigKeyring(keyring));
        } catch (err: any) {
            throw new ConfigKeyringInvalidError(`The keyring to write isn't usable: ${err.message}`);
        }
        const path: string = this.dataPath();
        const cas: number = Number(version);
        if (!/^\d+$/.test(version) || !Number.isSafeInteger(cas)) {
            throw new Error("The keyring secret's version isn't a KV version.");
        }
        try {
            await this.client().request("POST", path, { options: { cas }, data: { [KEYRING_KV_PROPERTY]: text } });
        } catch (err: any) {
            // KV v2 refuses a write whose check-and-set version is not the current one with a 400 that says so.
            if (err instanceof OpenBaoError && err.kind === "rejected" && err.status === 400 && /check-and-set/i.test(err.message)) {
                throw new ConfigKeyringConflictError();
            }
            throw err;
        }
    }
}
