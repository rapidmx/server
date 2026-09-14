///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////

/**
 * Resolves the on-disk path to the `@rapidmx/web-client` package's `www`/`admin`/`escrow` app directory -
 * an ordinary npm registry dependency installed under `node_modules` (see `.claude/NOTES.md`'s 2026-09-10
 * spike entry for the history, when it was still `portal:`-linked). Used as `WwwRoute`/`AdminConsoleRoute`/`EscrowConsoleRoute`'s
 * `appDir` override in place of the old local `apps/www`/`apps/admin`/`apps/escrow`.
 *
 * Mirrors `@rapidrest/react`'s own `ReactRoute.resolveAppFile()` `hasTsxContext` detection exactly: in
 * a tsx/test context, page files are imported directly as `.tsx` straight from the package's own `apps/`
 * source (live-editable, no rebuild needed); otherwise (a real compiled `node dist/src/server.*.js` run)
 * only `.js` files are looked up, so this must point at `web-client`'s own compiled `dist/apps/<name>`
 * mirror instead. `ReactRoute`'s own `dist/<appDir>` production fallback would NOT find that mirror on
 * its own — that fallback assumes `appDir` is relative to *this* project's own `dist/`, not to a
 * `node_modules` package's independent `dist/` — hence resolving the correct directory explicitly here
 * rather than relying on it.
 */
export function webClientAppDir(name: "www" | "admin" | "escrow"): string {
    const mainEntry: string = process.argv[1] ?? "";
    const hasTsxContext: boolean =
        mainEntry.endsWith(".ts") ||
        mainEntry.endsWith(".tsx") ||
        process.env.VITEST === "true" ||
        !!process.env.JEST_WORKER_ID;
    const base = "node_modules/@rapidmx/web-client";
    return hasTsxContext ? `${base}/apps/${name}` : `${base}/dist/apps/${name}`;
}
