///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { findPluginNamespace, HostConfig, NpmRegistryClient, type PluginNamespace } from "@rapidmx/restapi";
import { readPluginRegistry } from "../integrations/pluginRegistry.js";

type RouteBase = new (...args: any[]) => object;

/**
 * Makes restapi's plugin route build its registry clients from the registry in force at each operation (restapi spec 11.3). Its own `@Config` copies of
 * `system:plugins:registry`, `registry_token` and `namespaces` are taken when the route is built, so the registry, token and namespaces an administrator sets in
 * the console's Integrations would only apply after a restart. This reads them through `HostConfig` instead, which also makes the packages a namespace allows
 * (`allowedPackages` is made from `namespaces`) and the namespaces it lists (`GET /namespaces`) current. In a process with no host the route's own apply.
 *
 * The two members it replaces are protected in restapi's route, so the class is returned as the type it extends: the route is the same to its callers.
 */
export function withLivePluginRegistry<B extends RouteBase>(Base: B) {
    class LiveRegistryPluginRoute extends Base {
        /** The namespaces as last normalized, with the text they were made from: a configuration that doesn't change is read (and its warnings given) once. */
        private liveNamespaces?: { json: string; namespaces: PluginNamespace[] };

        protected get namespaces(): PluginNamespace[] {
            if (!HostConfig.isInstalled()) {
                // The route's own, taken when it was built (an accessor of the base class, read with this route as its receiver).
                return Reflect.get(Base.prototype, "namespaces", this) as PluginNamespace[];
            }
            const json: string = JSON.stringify(HostConfig.get("system:plugins:namespaces") ?? null);
            if (this.liveNamespaces?.json !== json) {
                const logger: any = (this as any).logger;
                this.liveNamespaces = { json, namespaces: readPluginRegistry((key) => HostConfig.get(key), logger).namespaces };
            }
            return this.liveNamespaces.namespaces;
        }

        protected createRegistryClient(packageOrNamespace?: string): NpmRegistryClient {
            if (!HostConfig.isInstalled()) {
                return Reflect.get(Base.prototype, "createRegistryClient", this).call(this, packageOrNamespace) as NpmRegistryClient;
            }
            const { url, token } = readPluginRegistry((key) => HostConfig.get(key));
            const namespaces: PluginNamespace[] = this.namespaces;
            const namespace: PluginNamespace | undefined = packageOrNamespace
                ? namespaces.find((candidate) => candidate.name === packageOrNamespace) ?? findPluginNamespace(packageOrNamespace, namespaces)
                : undefined;
            // A namespace on its own registry never gets the default registry's token; one on the default registry uses its own token when it has one.
            return namespace?.registry ? new NpmRegistryClient(namespace.registry, namespace.token) : new NpmRegistryClient(url, namespace?.token ?? token);
        }
    }
    return LiveRegistryPluginRoute as unknown as B;
}
