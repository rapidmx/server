///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { dnsCredentialContext, isConfigEnvelope, type ConfigCipher, type PublicDnsProvider, type SecretMask } from "@rapidmx/restapi";
import { UnreadableSecrets } from "./UnreadableSecrets.js";

/** A mask that tells the console the secret is set but this process couldn't read it (spec 10.2, "Unreadable secrets in the view"): the console shows "Set, but can't be read: enter it again" and still sends the plain mask back. */
export type UnreadableSecretMask = SecretMask & { unreadable: true };

/**
 * `view` with `unreadable: true` added to the mask of each credential that can't be read. It never decrypts, and answers from two things: what an earlier
 * decryption in this process said (`UnreadableSecrets`), and whether the key the envelope names is one this process has loaded at all, which holds in every server
 * copy at once (a backup restored with an older keyring) rather than only in the copy that happened to try. A credential entered again is a new envelope under
 * the active key, so it counts as readable at once.
 *
 * @param view The provider as restapi's route shows it, with a plain mask per credential saved.
 * @param provider The row it was made from, whose envelopes say which credential is which.
 * @param cipher The server's cipher, which knows the keys this process has loaded.
 */
export function markUnreadableCredentials(
    view: PublicDnsProvider,
    provider: { uid: string; credentials?: Record<string, unknown> | null },
    cipher?: Pick<ConfigCipher, "loadedKids">,
): PublicDnsProvider {
    const credentials: Record<string, SecretMask> = { ...view.credentials };
    const loaded: string[] | undefined = cipher?.loadedKids();
    for (const field of Object.keys(credentials)) {
        const envelope: unknown = provider.credentials?.[field];
        const keyMissing: boolean = !!loaded && isConfigEnvelope(envelope) && !loaded.includes(envelope.kid);
        if (keyMissing || UnreadableSecrets.isUnreadable(dnsCredentialContext(provider.uid, field), envelope)) {
            credentials[field] = { secret: true, unreadable: true } as UnreadableSecretMask;
        }
    }
    return { ...view, credentials };
}
