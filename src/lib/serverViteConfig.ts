///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import path from "path";

/**
 * The server's own browser apps, relative to the server's directory: the web client's www, admin and escrow consoles
 * (built from `@rapidmx/web-client`'s TSX sources, never its compiled `dist/apps` mirror). Every page under these gets a
 * client hydration entry. Plugin apps (such as the booking pages) are added by `PluginUiBuilder` at startup.
 */
export const CORE_APP_DIRS: readonly string[] = [
    "node_modules/@rapidmx/web-client/apps/www",
    "node_modules/@rapidmx/web-client/apps/admin",
    "node_modules/@rapidmx/web-client/apps/escrow",
];

/**
 * The core apps that navigate between their pages on the client (`@rapidrest/react`'s router): the webmail and the admin and
 * escrow consoles. The build gets a router entry for each, and their routes (`WwwRoute`, `AdminConsoleRoute`,
 * `EscrowConsoleRoute`) set `router = true`. The webmail's persistent app frame is the router's app shell
 * (`@rapidmx/web-client`'s `apps/www/_shell.tsx`, built into its router entry); plugin apps hydrate page by page.
 */
export const ROUTER_APP_DIRS: readonly string[] = [
    "node_modules/@rapidmx/web-client/apps/www",
    "node_modules/@rapidmx/web-client/apps/admin",
    "node_modules/@rapidmx/web-client/apps/escrow",
];

/**
 * What the router entries are built with (`createViteConfig({ router })`). The options are the same for every routed app, so each
 * entry is only given what is right for all of them:
 *
 * - `prefetch.idle`: the webmail's four rail pages, whose code is downloaded once the browser is idle after the first load (never
 *   when the user asked to save data), so the likeliest next click is instant. In the admin and escrow entries these URLs are another
 *   app's, which a router never handles, so they do nothing there.
 * - `prefetch.links`: a plain `<a href>` warms its page (code and props) when it is pointed at, pressed or focused, as a `Link` does.
 *   The webmail's own links are plain anchors (the rail, the settings menu, the bottom tab bar, folder lists); the ones that stay on
 *   the page (a folder or an all-mailboxes view, which change only the query) opt out with `data-router-prefetch="false"`.
 *
 * Focus, scroll and the announcement after a navigation are set by the web client's shell (`useNavigationEffects()`), not here.
 */
export const ROUTER_OPTIONS = {
    prefetch: { idle: ["/", "/calendar", "/contacts", "/tasks"], links: true },
} as const;

/** The web client's Tailwind entry point: its design tokens and the `@source` lines for its own and react-shared's classes. */
export const WEB_CLIENT_APP_CSS = "node_modules/@rapidmx/web-client/apps/shared/styles/app.css";

/** The id prefix `@rapidrest/react`'s hydration plugin gives each page's generated client entry module. */
const HYDRATION_ENTRY_PREFIX = "\0rapidrest-entry:";

/** A stylesheet every page of an app directory imports from its client entry. */
export interface AppStylesheet {
    /** The app directory, as listed in the build's app dirs. */
    appDir: string;
    /** The stylesheet, relative to the working directory or absolute. */
    css: string;
}

export interface ServerViteConfigOptions {
    /** App directories built along with `CORE_APP_DIRS`, relative to the working directory with forward slashes. */
    extraAppDirs?: string[];
    /** Where the build is written. Defaults to `dist/public`. */
    outDir?: string;
    /** Stylesheets to add to app directories whose pages import none of their own. */
    stylesheets?: AppStylesheet[];
}

/**
 * A Vite plugin that makes each page of an app directory import a stylesheet from its hydration entry, so the page's
 * manifest entry lists that stylesheet and the server links it. Pages that already reach a stylesheet through a shell
 * component keep it; this is for apps whose pages don't (plugin apps).
 */
export function appStylesheetPlugin(stylesheets: AppStylesheet[]): any {
    const rules = stylesheets.map(({ appDir, css }) => ({
        prefix: `${appDir.replace(/\\/g, "/").replace(/\/+$/, "")}/`,
        css: path.resolve(css).replace(/\\/g, "/"),
    }));
    return {
        name: "rapidmx-app-stylesheets",
        transform(code: string, id: string) {
            if (!id.startsWith(HYDRATION_ENTRY_PREFIX)) {
                return undefined;
            }
            const key: string = id.slice(HYDRATION_ENTRY_PREFIX.length);
            const imports: string[] = rules.filter((rule) => key.startsWith(rule.prefix)).map((rule) => `import ${JSON.stringify(rule.css)};`);
            return imports.length > 0 ? { code: `${imports.join("\n")}\n${code}`, map: null } : undefined;
        },
    };
}

/**
 * The Vite build configuration for the server's browser bundles, shared by `vite.config.ts` (the image's prebuilt
 * `dist/public`) and `PluginUiBuilder` (the same build plus enabled plugins' UI apps, made at startup).
 *
 * `resolve.dedupe` forces every import of react/react-dom onto one physical copy, so hooks from `@rapidmx/react-shared`
 * (and from plugins) share the server's React instance instead of failing with "Invalid hook call".
 *
 * `resolve.alias` sends package imports of the web client (`@rapidmx/web-client/<path>.js`, the plugin UI surface) to
 * its TSX sources, the same modules the core pages are built from. Its package exports point at the compiled
 * `dist/apps` mirror, which is for server-side rendering; bundling a plugin page through the mirror would add a second
 * copy of every web client module it uses, with its own module state, next to the copies the core pages share.
 *
 * `build.rolldownOptions.output.strictExecutionOrder` keeps modules running in import order. Without it Rolldown runs
 * a CommonJS module lazily where it's imported but hoists ESM modules, so `@rapidmx/react-shared`'s
 * `import "reflect-metadata"` (CommonJS) ran after `@peculiar/x509`'s ESM dependency tsyringe, which throws "tsyringe
 * requires a reflect polyfill" on load and left every page that imports the crypto modules blank. The web client loads
 * those modules lazily (`import()`) now, and `@rapidmx/react-shared` awaits `reflect-metadata` before `@peculiar/x509`
 * where it loads that; the ordering guarantee is what keeps a lazy chunk that holds both correct.
 *
 * `build.rolldownOptions.output.codeSplitting` names the stable third-party pieces, so that they are chunks of their own
 * rather than parts of whichever shared chunk Rolldown happens to fold them into (which was one 1 MB chunk named after an
 * arbitrary module, `MailboxProvisioning-*.js`, and a `client-*.js` holding react-dom and the whole icon set).
 *
 * The `react` group is React, React DOM and the scheduler, byte-for-byte the same from one release of the app to the next, so a
 * returning visitor keeps it cached across every deploy of the web client (its `Cache-Control` is immutable).
 *
 * The `icons` group is the Heroicons v2 set (`react-icons/hi2`, the app's own icons) and the shared icon base, which change
 * whenever any page starts using another icon. The Bootstrap icons only the compose toolbar uses stay with the compose chunk.
 *
 * Everything else keeps Rolldown's default splitting, which is what makes the lazily loaded parts (the compose editor, the
 * emoji list, the S/MIME and X.509 code, each page of the client-side router) separate chunks.
 */
export async function createServerViteConfig(options: ServerViteConfigOptions = {}): Promise<any> {
    const { createViteConfig } = await import("@rapidrest/react/vite");
    const { default: tailwindcss } = await import("@tailwindcss/vite");
    const stylesheets: AppStylesheet[] = options.stylesheets ?? [];
    const config: any = await createViteConfig({
        appDir: [...CORE_APP_DIRS, ...(options.extraAppDirs ?? [])],
        router: { appDirs: [...ROUTER_APP_DIRS], prefetch: { ...ROUTER_OPTIONS.prefetch, idle: [...ROUTER_OPTIONS.prefetch.idle] } },
        ...(options.outDir ? { outDir: options.outDir } : {}),
        plugins: [appStylesheetPlugin(stylesheets), tailwindcss()],
    });
    const rolldownOptions: any = config.build?.rolldownOptions ?? {};
    return {
        ...config,
        build: {
            ...config.build,
            rolldownOptions: {
                ...rolldownOptions,
                output: {
                    ...rolldownOptions.output,
                    strictExecutionOrder: true,
                    codeSplitting: {
                        groups: [
                            { name: "react", test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/, priority: 30 },
                            { name: "icons", test: /node_modules[\\/]react-icons[\\/](hi2|lib)[\\/]/, priority: 20 },
                        ],
                    },
                },
            },
        },
        resolve: {
            ...config.resolve,
            alias: [webClientSourceAlias()],
            dedupe: ["react", "react-dom"],
        },
    };
}

/** The web client's app sources, relative to the server's directory. */
export const WEB_CLIENT_APPS = "node_modules/@rapidmx/web-client/apps";

/** The Vite alias that resolves `@rapidmx/web-client/<path>.js` to `<path>` under the web client's app sources, where
 * Vite then finds the `.ts` or `.tsx` file. */
export function webClientSourceAlias(): { find: RegExp; replacement: string } {
    return { find: /^@rapidmx\/web-client\/(.+)\.js$/, replacement: `${path.resolve(WEB_CLIENT_APPS).replace(/\\/g, "/")}/$1` };
}
