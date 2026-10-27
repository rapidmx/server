///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { readFile } from "node:fs/promises";
import { ApiError, ObjectDecorators } from "@rapidrest/core";
import { ApiErrors } from "@rapidrest/service-core";
import { EncryptionCertificateAuthority, OpenBaoPkiCertificateAuthority } from "@rapidmx/restapi";
import { DEFAULT_OPENBAO_TOKEN_FILE, OpenBaoClient, OpenBaoError, OpenBaoTransport, nodeTransport, openBaoClientOptions } from "./OpenBaoClient.js";
const { Config, Logger } = ObjectDecorators;

/**
 * restapi's base class, typed without its private members: this class replaces one of them, `request()`, which TypeScript would
 * otherwise refuse (a subclass may not redeclare a private member).
 */
const PkiCertificateAuthority = OpenBaoPkiCertificateAuthority as unknown as new () => EncryptionCertificateAuthority;

/**
 * restapi's `OpenBaoPkiCertificateAuthority` (`mail:pki:backend: "openbao"`), with its requests sent through the server's `OpenBaoClient`
 * instead of the global `fetch` with a static token: so it verifies the in-cluster OpenBao's listener with the CA the installer copies
 * into the namespace (`mail:pki:openbao:ca_file`), and logs in with the pod's projected ServiceAccount token as the installer's
 * `<fullname>-server` role (`mail:pki:openbao:auth:*`), which leaves no long-lived token to keep. Everything else is restapi's: the
 * request it signs, the check that the certificate OpenBao returns is the one asked for (revoking it otherwise) and the serial map
 * `revoke()` reads.
 *
 * `mail:pki:openbao:token` still works on its own (`auth:method` "token", the default) for a vault prepared by hand.
 */
export class OpenBaoClientPkiCertificateAuthority extends PkiCertificateAuthority {
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

    @Logger
    private log: any;

    private openBao?: OpenBaoClient;

    constructor() {
        super();
        // If restapi stopped sending its requests through request(), they would go out through the global fetch with an empty token: fail
        // loudly at startup instead.
        if (typeof (OpenBaoPkiCertificateAuthority.prototype as any).request !== "function") {
            throw new Error("OpenBaoClientPkiCertificateAuthority: @rapidmx/restapi's OpenBaoPkiCertificateAuthority no longer has the request() method this replaces.");
        }
    }

    /** The transport the client sends with (replaced in tests). */
    protected openBaoTransport(): OpenBaoTransport {
        return nodeTransport;
    }

    /** Reads the CA bundle and the ServiceAccount token (replaced in tests). */
    protected async readTextFile(file: string): Promise<string> {
        return readFile(file, "utf8");
    }

    /** Built on first use, from the configuration injected after construction. */
    private client(): OpenBaoClient {
        this.openBao ??= new OpenBaoClient({
            ...openBaoClientOptions("mail:pki:openbao", {
                address: this.openBaoAddress,
                ca_file: this.caFile,
                token: this.staticToken,
                timeout_ms: this.openBaoTimeoutMs,
                auth: { method: this.authMethod, role: this.authRole, mount_path: this.authMountPath, token_file: this.authTokenFile },
            }),
            transport: this.openBaoTransport(),
            readFile: (file) => this.readTextFile(file),
        });
        return this.openBao;
    }

    /** Replaces restapi's: the same call and the same errors as restapi's own (500 for settings that can't work, 502 otherwise). */
    protected async request<T>(urlPath: string, body: Record<string, unknown>): Promise<T> {
        try {
            return (await this.client().request<T>("POST", urlPath, body)) as T;
        } catch (err: any) {
            if (err instanceof OpenBaoError && err.kind === "config") {
                // Not cached: a corrected file (the CA, the ServiceAccount token) is read again on the next request.
                this.log?.error(`OpenBaoClientPkiCertificateAuthority: ${err.message}`);
                throw new ApiError(ApiErrors.INTERNAL_ERROR, 500, err.message);
            }
            if (err instanceof OpenBaoError && err.kind === "rejected") {
                this.log?.error(`OpenBaoClientPkiCertificateAuthority: ${err.message}`);
                throw new ApiError(ApiErrors.INTERNAL_ERROR, 502, "The configured PKI server rejected the request.");
            }
            this.log?.error(`OpenBaoClientPkiCertificateAuthority: request to '${urlPath}' failed: ${err?.message ?? String(err)}`);
            throw new ApiError(ApiErrors.INTERNAL_ERROR, 502, "The configured PKI server could not be reached.");
        }
    }
}
