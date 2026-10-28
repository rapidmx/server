///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import {
    assertProductionConfigKeyring,
    ConfigCipher,
    ConfigKeyHeartbeat,
    ensureDevelopmentConfigKeyring,
    type PluginSecretEncryptionResult,
} from "@rapidmx/restapi";
import { SECRETS_GUARD_SKIP_ENVIRONMENTS, type SecretsConfig, type WritableConfig } from "../config.defaults.js";

/** Where `yarn dev` keeps its configuration keyring: under `data/`, which is git-ignored and which the docker-compose stacks keep on a volume. */
export const DEV_CONFIG_KEYRING_FILE = "./data/config-keyring.json";

/** The class name the plugin host's cipher is registered under, apart from the `"ConfigCipher"` the routes and jobs inject. */
const PLUGIN_HOST_CIPHER = "PluginHostConfigCipher";

/** Whether `environment` is a development one, where the checked-in development secrets and the development keyring are allowed: the same two as the secrets guard. */
function isDevelopment(environment: string | undefined): boolean {
    return environment !== undefined && SECRETS_GUARD_SKIP_ENVIRONMENTS.includes(environment);
}

/**
 * Refuses to let the server start without a usable configuration keyring (spec 5.2), in the environments where it refuses a default JWT secret: anything but an
 * explicit `dev`/`development` `NODE_ENV`. Secrets could otherwise be saved with no key to read them back. The keyring is `config_encryption:keyring_file`, else
 * `config_encryption:keyring`; the error names the setting, never what it holds.
 *
 * @param config The loaded runtime configuration.
 * @param environment The raw `NODE_ENV`.
 * @throws If there is no keyring, or it can't be read or isn't one.
 */
export function assertConfigKeyringIsSet(config: SecretsConfig, environment: string | undefined): void {
    assertProductionConfigKeyring(
        { keyringFile: config.get("config_encryption:keyring_file") as string | undefined, keyring: config.get("config_encryption:keyring") },
        !isDevelopment(environment),
    );
}

/** Whether a configuration value is set: not undefined, null or blank text. */
function isSet(value: unknown): boolean {
    return value !== undefined && value !== null && !(typeof value === "string" && value.trim() === "");
}

/**
 * Under `yarn dev` (an explicit `dev`/`development` `NODE_ENV`), gives the server a configuration keyring of its own when none is configured: generated into
 * `file` the first time (readable by its owner only, never overwritten, so what was encrypted with it stays readable), with `config_encryption:keyring_file` set
 * to it and the keyring store set to `file` (restapi's `FileConfigKeyringStore`) unless one was chosen, so key rotation works in development too. A no-op
 * everywhere else, where the production guard (`assertConfigKeyringIsSet()`) applies, and when a keyring is configured.
 *
 * @param config The runtime configuration, which gets the two settings.
 * @param environment The raw `NODE_ENV`.
 * @param logger Says where the keyring is.
 * @param file Where the keyring is kept.
 * @throws If `file` exists and is not a keyring.
 */
export async function ensureDevelopmentKeyring(
    config: WritableConfig,
    environment: string | undefined,
    logger: { info(message: string): void },
    file: string = DEV_CONFIG_KEYRING_FILE,
): Promise<void> {
    if (!isDevelopment(environment) || isSet(config.get("config_encryption:keyring_file")) || isSet(config.get("config_encryption:keyring"))) {
        return;
    }
    await ensureDevelopmentConfigKeyring(file);
    config.set("config_encryption:keyring_file", file);
    const backend: unknown = config.get("config_encryption:keyring_store:backend");
    if (!isSet(backend) || backend === "none") {
        config.set("config_encryption:keyring_store:backend", "file");
    }
    logger.info(`[dev] Using the development configuration keyring at ${file}. It is generated on first use and must not be committed.`);
}

/** The part of the `ObjectFactory` this needs. */
export interface ConfigEncryptionFactory {
    register(clazz: any, fqn?: string): void;
    newInstance<T>(type: any, options?: { name?: string; args?: unknown[] }): T | Promise<T>;
}

/** The part of `PluginSecretEncryptor` the server drives. */
interface PluginSecretEncryptorRunner {
    runUntilEncrypted(options: { signal: AbortSignal }): Promise<PluginSecretEncryptionResult>;
}

/** What `startConfigEncryption()` started, to be stopped with the server. */
export interface ConfigEncryptionRuntime {
    /** Stops waiting for the rollout and waits for the run in progress, if any, to end. Safe to call again. */
    stop(): Promise<void>;
}

/**
 * The cipher the plugin host decrypts and hashes with: restapi's `ConfigCipher` with no datastore behind it. The host runs before any of the server's
 * datastores connect (the plugin set decides which classes load), so it can't be the datastore-reading `ConfigCipherMongo`/`SQL` the routes get; decrypting
 * needs only the keyring, which it re-reads every minute and when an envelope names a key it doesn't have, as the routes' cipher does.
 *
 * It is built under a class name of its own: the factory resolves a class by name and `registerCoreProviders()` has already registered the datastore-reading
 * cipher as `"ConfigCipher"`, so asking for `ConfigCipher` would build that one (and fail, with no datastore connected) and make this instance the default that
 * every `@Inject("ConfigCipher")` gets.
 */
export async function createPluginHostCipher(objectFactory: ConfigEncryptionFactory): Promise<ConfigCipher> {
    objectFactory.register(ConfigCipher, PLUGIN_HOST_CIPHER);
    return objectFactory.newInstance<ConfigCipher>(PLUGIN_HOST_CIPHER, { name: "plugin-host" });
}

/**
 * Starts the configuration encryption's background work once the server is up and its datastores are connected: the keyring heartbeat, which tells the other
 * server copies which keys this process has loaded (a rotation activates a key only when every copy reports it, spec 5.5), and the run that encrypts the
 * plugin secret settings still in plaintext, which waits for the server's rollout to finish (spec 5.7). Neither delays the start or the plugin host, and neither
 * can stop the server from starting: a piece that can't be built, or a run that fails, is logged and the other still runs.
 *
 * @param objectFactory The server's `ObjectFactory`, which builds both and destroys the heartbeat with the server.
 * @param encryptorClass The datastore's `PluginSecretEncryptorMongo` or `PluginSecretEncryptorSQL`.
 * @param logger Where a failure is said.
 */
export async function startConfigEncryption(
    objectFactory: ConfigEncryptionFactory,
    encryptorClass: new () => unknown,
    logger: { warn(message: string): void; error(message: string): void },
): Promise<ConfigEncryptionRuntime> {
    try {
        await objectFactory.newInstance<ConfigKeyHeartbeat>(ConfigKeyHeartbeat, { name: "default" });
    } catch (err: any) {
        logger.error(`The configuration keyring heartbeat could not be started, so a key rotation will not see this server copy: ${err?.message}`);
    }
    const abort: AbortController = new AbortController();
    let running: Promise<void> = Promise.resolve();
    try {
        const encryptor: PluginSecretEncryptorRunner = await objectFactory.newInstance<PluginSecretEncryptorRunner>(encryptorClass, { name: "default" });
        // Not awaited: while old pods remain it asks again every 30 seconds, and the server is serving meanwhile.
        running = encryptor
            .runUntilEncrypted({ signal: abort.signal })
            .then(() => undefined)
            .catch((err: any) => logger.warn(`The plugin secret settings could not be encrypted on this start: ${err?.message}`));
    } catch (err: any) {
        logger.error(`The plugin secret settings' encryption could not be started: ${err?.message}`);
    }
    return {
        stop: async () => {
            abort.abort();
            await running;
        },
    };
}
