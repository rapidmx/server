///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import fs from "fs";
import path from "path";
import { webClientAppDir } from "../routes/webClientAppDir.js";

/** The names in a directory that are pages: files and directories, less `index` and the `_layout`, `_404` and other `_` files. */
function pageNames(dir: string): string[] {
    try {
        return fs
            .readdirSync(dir, { withFileTypes: true })
            .filter((entry) => entry.isDirectory() || /\.(tsx|jsx|js|mjs)$/.test(entry.name))
            .map((entry) => entry.name.replace(/\.(tsx|jsx|js|mjs)$/, ""))
            .filter((name) => name !== "index" && !name.startsWith("_") && !name.startsWith(".") && name !== "shared");
    } catch {
        return [];
    }
}

/**
 * The mounts a plugin's UI app can never take because the installed `@rapidmx/web-client` already serves a page there:
 * the top-level pages of its `www` (`/<page>` and `/settings/<page>`), `admin` (`/admin/<page>`) and `escrow`
 * (`/escrow/<page>`) apps, read from disk. `@rapidmx/restapi`'s hand-maintained `RESERVED_PLUGIN_UI_MOUNTS` has drifted from
 * these before (`/admin/diagnostics`, `/admin/signing-certificates`, `/settings/appearance`), and a plugin on one of them takes
 * over a core page, since the more specific route wins - so the server checks the real directories as well.
 *
 * @param appRoot The directory the server runs from, which holds `node_modules`.
 * @returns The mounts, lowercase and with no trailing slash.
 */
export function webClientReservedMounts(appRoot: string): Set<string> {
    const mounts: Set<string> = new Set(["/admin", "/escrow"]);
    const dir = (name: "www" | "admin" | "escrow"): string => path.resolve(appRoot, webClientAppDir(name));
    for (const name of pageNames(dir("www"))) {
        mounts.add(`/${name}`);
    }
    for (const name of pageNames(path.join(dir("www"), "settings"))) {
        mounts.add(`/settings/${name}`);
    }
    for (const name of pageNames(dir("admin"))) {
        mounts.add(`/admin/${name}`);
    }
    for (const name of pageNames(dir("escrow"))) {
        mounts.add(`/escrow/${name}`);
    }
    return new Set([...mounts].map((mount) => mount.toLowerCase()));
}
