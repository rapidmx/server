///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////

/**
 * Whether page files can be imported as TSX source: under tsx (`yarn dev`) or a test runner. Otherwise (a compiled
 * `node dist/src/server.*.js` run) only compiled `.js` pages can be imported. Mirrors `@rapidrest/react`'s own
 * `ReactRoute.resolveAppFile()` `hasTsxContext` detection exactly.
 */
export function hasTsxContext(): boolean {
    const mainEntry: string = process.argv[1] ?? "";
    return mainEntry.endsWith(".ts") || mainEntry.endsWith(".tsx") || process.env.VITEST === "true" || !!process.env.JEST_WORKER_ID;
}

/**
 * Resolves the on-disk path to the `@rapidmx/web-client` package's `www`/`admin`/`escrow` app directory -
 * an ordinary npm registry dependency installed under `node_modules` (see `.claude/NOTES.md`'s 2026-09-10
 * spike entry for the history, when it was still `portal:`-linked). Used as `WwwRoute`/`AdminConsoleRoute`/`EscrowConsoleRoute`'s
 * `appDir` override in place of the old local `apps/www`/`apps/admin`/`apps/escrow`.
 *
 * In a tsx/test context (`hasTsxContext()`), page files are imported directly as `.tsx` straight from the package's
 * own `apps/` source (live-editable, no rebuild needed); otherwise only `.js` files are looked up, so this must point
 * at `web-client`'s own compiled `dist/apps/<name>` mirror instead. `ReactRoute`'s own `dist/<appDir>` production
 * fallback would NOT find that mirror on its own — that fallback assumes `appDir` is relative to *this* project's own
 * `dist/`, not to a `node_modules` package's independent `dist/` — hence resolving the correct directory explicitly
 * here rather than relying on it. Plugin UI apps are shipped the same way (see `PluginUiRoutes.ts`).
 */
export function webClientAppDir(name: "www" | "admin" | "escrow"): string {
    const base = "node_modules/@rapidmx/web-client";
    return hasTsxContext() ? `${base}/apps/${name}` : `${base}/dist/apps/${name}`;
}
