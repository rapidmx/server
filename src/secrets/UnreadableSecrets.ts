///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ConfigSecretUnavailableError, type ConfigCipherContext, type ConfigEnvelope, type ConfigSecretValue } from "@rapidmx/restapi";

/** The most failures remembered; a deployment has a few dozen secrets, so this is only a bound on what a damaged table could add. */
const MAX_REMEMBERED = 1000;

/** What identifies the envelope that failed: a re-saved secret has a new nonce, so it is a different envelope. */
function fingerprint(envelope: Pick<ConfigEnvelope, "kid" | "iv">): string {
    return `${envelope.kid}:${envelope.iv}`;
}

function keyOf(context: ConfigCipherContext): string {
    return JSON.stringify([context.record, context.uid, context.field]);
}

/**
 * The secrets this process has tried to decrypt and couldn't (spec 5.4, 10.2): a `kid` missing from the keyring after a restore with an older one, or an
 * envelope that was copied to another row or field. The admin console shows such a secret as "Set, but can't be read: enter it again", and a view must not
 * decrypt to find out (decrypted secrets are cached in memory for the life of the process, not read per request), so it asks what a decryption has already
 * said: every decryption in this process goes through the cipher the server registers (`TrackedConfigCipherMongo`/`SQL`), which records the failures here
 * and forgets a secret the next time it reads.
 *
 * Only the envelope that failed counts: a secret entered again is a new envelope, readable at once, with no decryption in between. Names the record, row and field,
 * never a value, an envelope or a key.
 */
export class UnreadableSecrets {
    private static readonly failed: Map<string, string> = new Map();

    /** Remembers that `envelope` couldn't be decrypted for `context`. */
    public static record(context: ConfigCipherContext, envelope: unknown): void {
        const { kid, iv } = (envelope ?? {}) as Partial<ConfigEnvelope>;
        const key: string = keyOf(context);
        // The most recent failure is the last in the map's order.
        UnreadableSecrets.failed.delete(key);
        UnreadableSecrets.failed.set(key, fingerprint({ kid: String(kid), iv: String(iv) }));
        if (UnreadableSecrets.failed.size > MAX_REMEMBERED) {
            UnreadableSecrets.failed.delete(UnreadableSecrets.failed.keys().next().value as string);
        }
    }

    /** Forgets `context`: its secret was just read. */
    public static clear(context: ConfigCipherContext): void {
        UnreadableSecrets.failed.delete(keyOf(context));
    }

    /** Whether this process has tried to decrypt `envelope`, the one a row holds for `context` now, and failed. */
    public static isUnreadable(context: ConfigCipherContext, envelope: unknown): boolean {
        const failed: string | undefined = UnreadableSecrets.failed.get(keyOf(context));
        if (failed === undefined || typeof envelope !== "object" || envelope === null) {
            return false;
        }
        const { kid, iv } = envelope as Partial<ConfigEnvelope>;
        return failed === fingerprint({ kid: String(kid), iv: String(iv) });
    }

    /** Forgets everything, for a test that starts over. */
    public static reset(): void {
        UnreadableSecrets.failed.clear();
    }

    /**
     * Runs `decrypt`, recording a failure to read the secret and clearing the record on success. Any other error is not about the secret and passes through.
     */
    public static track(context: ConfigCipherContext, envelope: ConfigEnvelope, decrypt: () => ConfigSecretValue): ConfigSecretValue {
        try {
            const value: ConfigSecretValue = decrypt();
            UnreadableSecrets.clear(context);
            return value;
        } catch (err) {
            if (err instanceof ConfigSecretUnavailableError) {
                UnreadableSecrets.record(context, envelope);
            }
            throw err;
        }
    }
}
