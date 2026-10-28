///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { DEFAULT_PLUGIN_NAMESPACES, DEFAULT_PLUGIN_REGISTRY, normalizePluginNamespaces, type PluginNamespace } from "@rapidmx/restapi";

/** The plugin registry as the configuration says it now. */
export interface PluginRegistryConfig {
    /** The default registry. */
    url: string;
    /** Its token, when it has one. */
    token?: string;
    /** The plugin namespaces, each with its own registry and token when it has them. */
    namespaces: PluginNamespace[];
}

/**
 * The plugin registry's settings (`system:plugins:registry`, `registry_token`, `namespaces`) read through `read` at this moment. The plugin route builds its
 * registry clients from this at each operation (restapi spec 11.3), so the registry an administrator sets in the console's Integrations is the next install's
 * or update's, without a restart. The plugin host does not: what it installs at start comes from the deployment's registry alone.
 */
export function readPluginRegistry(read: (key: string) => unknown, logger?: { warn(message: string): void }): PluginRegistryConfig {
    const url: unknown = read("system:plugins:registry");
    const token: unknown = read("system:plugins:registry_token");
    return {
        url: typeof url === "string" && url !== "" ? url : DEFAULT_PLUGIN_REGISTRY,
        token: typeof token === "string" && token !== "" ? token : undefined,
        namespaces: normalizePluginNamespaces(read("system:plugins:namespaces") ?? DEFAULT_PLUGIN_NAMESPACES, logger),
    };
}
