///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * Node module customization hook (registered via `register()` in `server.ts`/`server.mongo.ts`/
 * `server.sql.ts`) that forces every `import "react"`/`import "react-dom"` — and their subpaths,
 * e.g. `react/jsx-runtime`, `react-dom/client`, `react-dom/server` — no matter which package's
 * module graph is asking, to resolve to *this project's own* installed copy rather than whatever
 * copy happens to live closest to the importing file on disk.
 *
 * Why this is needed: `@rapidmx/web-client` is a `link:`-ed sibling repo with its own independent
 * `node_modules/react` (needed so it can run its own test suite standalone — see its own
 * `.claude/NOTES.md`). Vite's `resolve.dedupe` (see
 * `vite.config.ts`) already solves this for the client bundle, but `ReactRoute.renderPage()`'s
 * SSR path loads page/layout modules via a plain Node `import()` — no Vite bundling involved at
 * all — so `resolve.dedupe` has no effect there. Node's own ESM resolver, walking up from wherever
 * a `.tsx` file *actually* lives on disk (its real, symlink-resolved path), finds
 * `@rapidmx/web-client`'s own `node_modules/react` before it ever reaches this project's, loading
 * a second, independent React module instance — every hook call inside one of its components then
 * throws "Invalid hook call" (two separate `ReactCurrentDispatcher`
 * singletons, one per instance).
 *
 * `--preserve-symlinks` does **not** fix this — confirmed empirically, not assumed. It only
 * changes the path *string* Node's resolver reports for the specifier; the physical file it
 * actually loads is still web-client's own `node_modules/react` (reached transparently through
 * the `@rapidmx/web-client` symlink one directory level before this project's own `node_modules`
 * would ever be reached), so it's still a second, separately-cached module instance under a
 * different apparent path — the hook call still breaks.
 *
 * Runs in Node's dedicated loader thread (a separate realm from the rest of this project), so it
 * must be fully self-contained — no importing anything from this project's own modules.
 *
 * @author Jean-Philippe Steinmetz
 */
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const projectRequire = createRequire(import.meta.url);
const REDIRECT_PACKAGES = ["react", "react-dom"];

export async function resolve(specifier: string, context: unknown, nextResolve: (specifier: string, context: unknown) => any) {
    if (REDIRECT_PACKAGES.some((pkg) => specifier === pkg || specifier.startsWith(`${pkg}/`))) {
        return { url: pathToFileURL(projectRequire.resolve(specifier)).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
}
