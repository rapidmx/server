///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import "reflect-metadata";
import { ReactRoute } from "@rapidrest/react";
import type { PluginUiHost } from "@rapidmx/restapi";
import { hasTsxContext } from "../routes/webClientAppDir.js";
import type { PluginUiAppFiles } from "./PluginInstaller.js";

/** The server's base route for each plugin UI host, for the datastore it runs on. A plugin app's route extends it, so
 * the app's pages get the same props (branding, sign-in and impersonation wiring, plugin navigation) as the host's. */
export type PluginUiHostClasses = Record<PluginUiHost, new (...args: any[]) => any>;

/** A route a registered class serves, reduced to the literal path before its first parameter or wildcard. */
export interface RegisteredRoutePath {
    /** The class-loader name of the route class. */
    name: string;
    path: string;
    /** Whether the class renders React pages below its path (so plugin pages may mount beneath it). */
    react: boolean;
}

/** `name` with everything but letters, digits and `_` replaced by `_`. */
function identifier(name: string): string {
    return name.replace(/[^A-Za-z0-9_]/g, "_");
}

/** The class-loader name a plugin UI app's route is registered under: `<package prefix>.ui.<app id>`. */
export function pluginUiRouteName(packagePrefix: string, appId: string): string {
    return `${packagePrefix}.ui.${identifier(appId)}`;
}

/**
 * Creates the route serving a plugin UI app: a subclass of its host's base route whose pages come from the app's
 * directory - its TSX sources under tsx or a test runner, its compiled `dist/<dir>` pages otherwise - mounted at the
 * app's `mount`.
 *
 * `@Route` metadata is inherited and concatenated, so the mount is defined directly on the subclass: through
 * `@Route(mount)` the subclass would also serve the host's own path.
 */
export function createPluginUiRoute(base: new (...args: any[]) => any, app: PluginUiAppFiles, name: string): new (...args: any[]) => any {
    const className: string = `PluginUi_${identifier(name)}`;
    const clazz = {
        [className]: class extends base {
            protected readonly appDir: string = hasTsxContext() ? app.sourceDir : app.ssrDir;
            protected readonly hydrate: boolean = true;
        },
    }[className];
    Reflect.defineMetadata("rrst:routePaths", [app.mount], clazz.prototype);
    return clazz;
}

/** Joins a route's base path and a handler's sub-path the way RapidREST registers them. */
function joinRoutePath(basePath: string, subpath: string): string {
    const sub: string = subpath.startsWith("/") ? subpath.substring(1) : subpath;
    return sub.length === 0 || basePath.endsWith("/") ? basePath + sub : `${basePath}/${sub}`;
}

/** `routePath` up to its first segment with a parameter or wildcard, without a trailing `/` (the root stays `/`). */
function literalPrefix(routePath: string): string {
    const segments: string[] = [];
    for (const segment of routePath.split("/").filter((part) => part.length > 0)) {
        if (/[:*(]/.test(segment)) {
            break;
        }
        segments.push(segment);
    }
    return `/${segments.join("/")}`;
}

/** Every path the route classes in `classes` serve (see `RegisteredRoutePath`), skipping `except`. */
export function registeredRoutePaths(classes: Map<string, any>, except: Set<string> = new Set()): RegisteredRoutePath[] {
    const result: RegisteredRoutePath[] = [];
    for (const [name, clazz] of classes) {
        if (except.has(name) || typeof clazz !== "function" || !clazz.prototype) {
            continue;
        }
        const basePaths: string[] | undefined = Reflect.getMetadata("rrst:routePaths", clazz.prototype);
        if (!basePaths) {
            continue;
        }
        const react: boolean = clazz.prototype instanceof ReactRoute;
        const subpaths: Set<string> = new Set();
        for (let proto = clazz.prototype; proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
            for (const key of Object.getOwnPropertyNames(proto)) {
                const methods: Map<string, string> | undefined = Reflect.getMetadata("rrst:route", clazz.prototype, key)?.methods;
                for (const subpath of methods?.values() ?? []) {
                    subpaths.add(subpath);
                }
            }
        }
        if (subpaths.size === 0) {
            subpaths.add("");
        }
        const paths: Set<string> = new Set();
        for (const basePath of basePaths) {
            for (const subpath of subpaths) {
                paths.add(literalPrefix(joinRoutePath(basePath, subpath)));
            }
        }
        for (const path of paths) {
            result.push({ name, path, react });
        }
    }
    return result;
}

/**
 * The first registered route a plugin UI mount would clash with, compared case-insensitively: one serving the mount
 * itself or a path beneath it, or a route other than a React page host that the mount lies beneath (`/mapi/*` for
 * `/mapi/x`). Pages may mount beneath a React host (`/admin/<name>` beneath the admin console); the root is ignored.
 */
export function findRouteCollision(mount: string, routes: RegisteredRoutePath[]): RegisteredRoutePath | undefined {
    const lowerMount: string = mount.toLowerCase().replace(/\/+$/, "");
    return routes.find((route) => {
        const routePath: string = route.path.toLowerCase();
        if (routePath === "/") {
            return false;
        }
        return routePath === lowerMount || routePath.startsWith(`${lowerMount}/`) || (!route.react && lowerMount.startsWith(`${routePath}/`));
    });
}
