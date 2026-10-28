///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ConfigCipherSQL } from "@rapidmx/restapi/sql";
import type { ConfigCipherContext, ConfigEnvelope, ConfigSecretValue } from "@rapidmx/restapi";
import { UnreadableSecrets } from "./UnreadableSecrets.js";

/**
 * restapi's `ConfigCipherSQL`, registered under `"ConfigCipher"`, that remembers which secrets this process couldn't decrypt (`UnreadableSecrets`): every
 * decryption in the process goes through it - the controller's credentials, the integrations layer, the key rotation's re-encryption - so a view can mark a
 * secret "set, but can't be read" from what has already been tried, without decrypting for the request. `decryptString()` calls `decrypt()`, so both are covered.
 */
export class TrackedConfigCipherSQL extends ConfigCipherSQL {
    public decrypt(envelope: ConfigEnvelope, context: ConfigCipherContext): ConfigSecretValue {
        return UnreadableSecrets.track(context, envelope, () => super.decrypt(envelope, context));
    }
}
