///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { PluginRegistry, type LoadedPlugin, type PluginManifest, type PluginUiNavItem } from "@rapidmx/restapi";

/** How a loaded plugin's UI fared this start. */
export interface LoadedPluginUi {
    /** `built` when the plugin's apps are in this start's UI build, `failed` when they aren't (see `error`). */
    status: "built" | "failed";
    error?: string;
    /** The mounts its pages are served at. */
    mounts: string[];
    /** Its navigation entries, without any linking beneath a mount that wasn't served. */
    nav: PluginNav;
}

/**
 * A `PluginRegistry` entry with the plugin's UI state. `PluginRegistry` keeps whatever fields its entries carry, so the
 * server records UI state there next to the name and version restapi defines.
 */
export interface LoadedPluginWithUi extends LoadedPlugin {
    /** Only set for plugins whose manifest declares UI apps or navigation. */
    ui?: LoadedPluginUi;
}

/** The navigation entries loaded plugins add to the web client and admin console shells (the shells' `pluginNav` prop). */
export interface PluginNav {
    settingsSections: PluginUiNavItem[];
    adminNav: PluginUiNavItem[];
    appRail: PluginUiNavItem[];
}

const NAV_LISTS: (keyof PluginNav)[] = ["settingsSections", "adminNav", "appRail"];

/** Whether `href` is `mount` or a page beneath it. */
function isBeneath(href: string, mount: string): boolean {
    const path: string = href.toLowerCase().split(/[?#]/)[0].replace(/\/+$/, "");
    const base: string = mount.toLowerCase().replace(/\/+$/, "");
    return path === base || path.startsWith(`${base}/`);
}

/** The manifest's navigation entries (only `id`, `label`, `href` and `icon`), leaving out any linking beneath `refusedMounts`. */
export function manifestNav(manifest: PluginManifest | undefined, refusedMounts: string[] = []): PluginNav {
    const nav: PluginNav = { settingsSections: [], adminNav: [], appRail: [] };
    for (const list of NAV_LISTS) {
        for (const item of manifest?.ui?.[list] ?? []) {
            if (refusedMounts.some((mount) => isBeneath(item.href, mount))) {
                continue;
            }
            nav[list].push({ id: item.id, label: item.label, href: item.href, ...(item.icon ? { icon: item.icon } : {}) });
        }
    }
    return nav;
}

/** The navigation entries of every loaded plugin whose UI built, in load order. Always all three lists, empty or not. */
export function getPluginNav(plugins: LoadedPluginWithUi[] = PluginRegistry.list()): PluginNav {
    const nav: PluginNav = { settingsSections: [], adminNav: [], appRail: [] };
    for (const plugin of plugins) {
        if (plugin.ui?.status !== "built") {
            continue;
        }
        for (const list of NAV_LISTS) {
            nav[list].push(...(plugin.ui.nav[list] ?? []));
        }
    }
    return nav;
}
