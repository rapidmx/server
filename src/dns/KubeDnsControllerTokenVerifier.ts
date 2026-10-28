///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import crypto, { type KeyObject } from "node:crypto";
import type { DnsControllerTokenVerifier } from "@rapidmx/restapi";
import { KubeClient } from "../diagnostics/KubeClient.js";

/** The audience of the projected ServiceAccount token the chart gives the DNS controller (spec 7.2), and the only one accepted. */
export const DNS_CONTROLLER_AUDIENCE = "rapidmx-internal-dns";

/** The most a token may weigh: a projected ServiceAccount token is about 1 KiB. */
const MAX_TOKEN_LENGTH = 16 * 1024;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;
/** The smallest RSA key accepted. */
const MIN_RSA_BITS = 2048;

type Algorithm = "RS256" | "ES256";

/** A token that does not verify. The message says why and never repeats the token. */
export class TokenError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "TokenError";
    }
}

export interface KubeDnsControllerTokenVerifierOptions {
    /** The Kubernetes client the keys and the issuer are read through; the pod's own service account, built on first use, when not given. */
    kube?: Pick<KubeClient, "get">;
    /** The audience a token must carry (`DNS_CONTROLLER_AUDIENCE`). */
    audience?: string;
    /** The least time between two fetches of the keys (default a minute). */
    refetchIntervalMs?: number;
    /** How long the keys are trusted before they are fetched again, even for a key id already known (default ten minutes). */
    maxKeyAgeMs?: number;
    /** Clock skew allowed between the API server that issued a token and this pod (default a minute). */
    leewaySeconds?: number;
    /** Milliseconds since the epoch. Replaceable for tests. */
    now?: () => number;
    /** The process environment `KubeClient.detect()` reads when no client is given. */
    env?: NodeJS.ProcessEnv;
    /** Where the service account is mounted; the standard path when not given. */
    serviceAccountDir?: string;
}

interface VerificationKey {
    alg: Algorithm;
    key: KeyObject;
}

/** `segment` base64url-decoded and parsed as a JSON object, or undefined. */
function jsonSegment(segment: string): Record<string, unknown> | undefined {
    try {
        const value: unknown = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
        return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
    } catch {
        return undefined;
    }
}

/** The algorithm a JWK is for, or undefined for a key that can't sign tokens the API server issues (RS256 or ES256). */
function keyAlgorithm(jwk: Record<string, unknown>): Algorithm | undefined {
    if (jwk.use !== undefined && jwk.use !== "sig") {
        return undefined;
    }
    const alg: Algorithm | undefined = jwk.kty === "RSA" ? "RS256" : jwk.kty === "EC" && jwk.crv === "P-256" ? "ES256" : undefined;
    return alg !== undefined && (jwk.alg === undefined || jwk.alg === alg) ? alg : undefined;
}

/**
 * Verifies the projected ServiceAccount token the DNS controller presents on `/internal/dns` (a JWT the API server signed, audience `rapidmx-internal-dns`)
 * against the cluster's service-account issuer keys, the way the API server's own authenticator does, without a TokenReview (which would need a ClusterRole).
 * restapi's `BaseDnsDesiredStateRoute` then compares the subject this returns with `mail:dns:controller:subject`; the server registers this class under the DI
 * token `"DnsControllerTokenVerifier"`.
 *
 * - The keys and the issuer come **in-cluster**, from `/openid/v1/jwks` and `/.well-known/openid-configuration` on the API server, through the pod's own
 * Kubernetes client (its token, the cluster CA). The `jwks_uri` the discovery document advertises is not used: on k3s it is the node's public address, which a
 * pod may not reach and which the in-cluster certificate does not name. The default `system:service-account-issuer-discovery` binding lets every
 * ServiceAccount read both, so the server needs no Role for it.
 * - Signature (RS256 or ES256, with the key the token's `kid` names), issuer, audience, expiry and not-before, with `leewaySeconds` of clock skew.
 * - Keys are cached, and fetched again for an unknown `kid` (the API server rotated its key) at most once per `refetchIntervalMs`, so forged ids can't make the
 * server hammer the API server. They are also fetched again once they are `maxKeyAgeMs` old, for a known `kid` too, so a key the API server has stopped
 * accepting (rotated out because it leaked) stops verifying here within minutes, not at the next restart. While they can't be fetched, a token of an unknown
 * `kid` is refused and the keys already known stay in use.
 *
 * Outside Kubernetes (docker-compose, `yarn dev`) there are no keys, so every token is refused, as an unregistered verifier would.
 */
export class KubeDnsControllerTokenVerifier implements DnsControllerTokenVerifier {
    private readonly now: () => number;
    private readonly audience: string;
    private readonly refetchIntervalMs: number;
    private readonly maxKeyAgeMs: number;
    private readonly leewaySeconds: number;
    private kube?: Pick<KubeClient, "get">;
    private keys: Map<string, VerificationKey> = new Map();
    private issuer?: string;
    /** When the last fetch was started, whether or not it worked: the time the minimum interval counts from. */
    private lastFetchAt?: number;
    /** When the keys held were fetched: the time their age counts from. */
    private keysFetchedAt?: number;
    private fetching?: Promise<void>;

    constructor(private readonly options: KubeDnsControllerTokenVerifierOptions = {}) {
        this.kube = options.kube;
        this.now = options.now ?? Date.now;
        this.audience = options.audience ?? DNS_CONTROLLER_AUDIENCE;
        this.refetchIntervalMs = options.refetchIntervalMs ?? 60000;
        this.maxKeyAgeMs = options.maxKeyAgeMs ?? 10 * 60000;
        this.leewaySeconds = options.leewaySeconds ?? 60;
    }

    /** Resolves to the verified token's subject (`system:serviceaccount:<namespace>:<name>`); rejects with `TokenError`. */
    public async verify(token: string): Promise<{ subject: string }> {
        if (token.length > MAX_TOKEN_LENGTH || !TOKEN_PATTERN.test(token)) {
            throw new TokenError("the token is malformed");
        }
        const [headerPart, claimsPart, signaturePart] = token.split(".");
        const header = jsonSegment(headerPart);
        const claims = jsonSegment(claimsPart);
        if (!header || !claims) {
            throw new TokenError("the token is malformed");
        }
        if (header.alg !== "RS256" && header.alg !== "ES256") {
            throw new TokenError("the token's algorithm is not RS256 or ES256");
        }
        if (typeof header.kid !== "string" || header.kid === "") {
            throw new TokenError("the token names no key");
        }
        const key: VerificationKey = await this.keyFor(header.kid);
        if (key.alg !== header.alg) {
            throw new TokenError("the token's key does not match its algorithm");
        }
        const data: Buffer = Buffer.from(`${headerPart}.${claimsPart}`);
        const signature: Buffer = Buffer.from(signaturePart, "base64url");
        const valid: boolean =
            key.alg === "RS256"
                ? crypto.verify("sha256", data, key.key, signature)
                : signature.length === 64 && crypto.verify("sha256", data, { key: key.key, dsaEncoding: "ieee-p1363" }, signature);
        if (!valid) {
            throw new TokenError("the token's signature does not verify");
        }
        this.checkClaims(claims);
        return { subject: claims.sub as string };
    }

    private checkClaims(claims: Record<string, unknown>): void {
        const now: number = Math.floor(this.now() / 1000);
        if (claims.iss !== this.issuer) {
            throw new TokenError("the token's issuer is not the cluster's");
        }
        const audiences: unknown[] = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
        if (!audiences.includes(this.audience)) {
            throw new TokenError("the token is not for this audience");
        }
        if (typeof claims.exp !== "number" || claims.exp + this.leewaySeconds <= now) {
            throw new TokenError("the token has expired");
        }
        if (typeof claims.nbf === "number" && claims.nbf - this.leewaySeconds > now) {
            throw new TokenError("the token is not valid yet");
        }
        if (typeof claims.sub !== "string" || claims.sub === "") {
            throw new TokenError("the token has no subject");
        }
    }

    /** The key `kid` names, fetching the keys when it is unknown and the last fetch is old enough, or when the keys have outlived `maxKeyAgeMs`. */
    private async keyFor(kid: string): Promise<VerificationKey> {
        let key: VerificationKey | undefined = this.keys.get(kid);
        const now: number = this.now();
        const sinceFetch: number | undefined = this.lastFetchAt === undefined ? undefined : now - this.lastFetchAt;
        const expired: boolean = this.keysFetchedAt !== undefined && now - this.keysFetchedAt >= this.maxKeyAgeMs;
        if ((!key || expired) && (this.fetching || sinceFetch === undefined || sinceFetch >= this.refetchIntervalMs)) {
            this.fetching ??= this.fetchKeys().finally(() => (this.fetching = undefined));
            try {
                await this.fetching;
            } catch (err) {
                // Keys that can't be renewed are used as they are, until a token needs one they don't have: the API server being briefly out of reach must not
                // refuse the DNS controller. The next token tries again, once the minimum interval has passed.
                if (!key) {
                    throw err;
                }
            }
            key = this.keys.get(kid);
        }
        if (!key) {
            throw new TokenError("the token's key is not one of the cluster's");
        }
        return key;
    }

    /** The pod's own Kubernetes client, built the first time it is needed; the reason there is none (outside Kubernetes, no token mounted) otherwise. */
    private async client(): Promise<Pick<KubeClient, "get">> {
        if (!this.kube) {
            const { client, reason } = await KubeClient.detect({ env: this.options.env, serviceAccountDir: this.options.serviceAccountDir });
            if (!client) {
                throw new Error(reason);
            }
            this.kube = client;
        }
        return this.kube;
    }

    /** The issuer and the raw key set, from the API server. */
    private async fetchDocuments(): Promise<{ issuer: string; jwks: unknown[] }> {
        const kube: Pick<KubeClient, "get"> = await this.client();
        const [discovery, set] = await Promise.all([
            kube.get<{ issuer?: unknown } | null>("/.well-known/openid-configuration"),
            kube.get<{ keys?: unknown } | null>("/openid/v1/jwks", { accept: "application/jwk-set+json" }),
        ]);
        if (typeof discovery?.issuer !== "string" || discovery.issuer === "") {
            throw new Error("the discovery document names no issuer");
        }
        if (!Array.isArray(set?.keys)) {
            throw new Error("the key set has no keys");
        }
        return { issuer: discovery.issuer, jwks: set.keys };
    }

    private async fetchKeys(): Promise<void> {
        this.lastFetchAt = this.now();
        let documents: { issuer: string; jwks: unknown[] };
        try {
            documents = await this.fetchDocuments();
        } catch (err) {
            throw new TokenError(`cannot fetch the cluster's service-account keys: ${(err as Error).message}`);
        }
        const keys: Map<string, VerificationKey> = new Map();
        for (const entry of documents.jwks) {
            const jwk = entry as Record<string, unknown> | null;
            const alg: Algorithm | undefined = jwk ? keyAlgorithm(jwk) : undefined;
            if (!jwk || !alg || typeof jwk.kid !== "string" || keys.has(jwk.kid)) {
                continue;
            }
            let key: KeyObject;
            try {
                key = crypto.createPublicKey({ key: jwk, format: "jwk" });
            } catch {
                // A key node:crypto can't import is one no token can be verified with.
                continue;
            }
            // node:crypto imports an RSA key of any size, an empty modulus included; the API server's are 2048 bits or more.
            if (alg === "RS256" && key.asymmetricKeyDetails!.modulusLength! < MIN_RSA_BITS) {
                continue;
            }
            keys.set(jwk.kid, { alg, key });
        }
        this.issuer = documents.issuer;
        this.keys = keys;
        this.keysFetchedAt = this.now();
    }
}
