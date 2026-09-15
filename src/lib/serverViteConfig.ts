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
 * requires a reflect polyfill" on load and left every page that imports the crypto modules blank.
 */
export async function createServerViteConfig(options: ServerViteConfigOptions = {}): Promise<any> {
    const { createViteConfig } = await import("@rapidrest/react/vite");
    const { default: tailwindcss } = await import("@tailwindcss/vite");
    const stylesheets: AppStylesheet[] = options.stylesheets ?? [];
    const config: any = await createViteConfig({
        appDir: [...CORE_APP_DIRS, ...(options.extraAppDirs ?? [])],
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
                output: { ...rolldownOptions.output, strictExecutionOrder: true },
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
