///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import path from "path";

/**
 * The server's own browser apps, relative to the server's directory: the web client's www, admin and escrow consoles
 * (built from `@rapidmx/web-client`'s TSX sources, never its compiled `dist/apps` mirror) and the repo-local booking
 * pages. Every page under these gets a client hydration entry.
 */
export const CORE_APP_DIRS: readonly string[] = [
    "node_modules/@rapidmx/web-client/apps/www",
    "node_modules/@rapidmx/web-client/apps/admin",
    "node_modules/@rapidmx/web-client/apps/escrow",
    "apps/book",
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
 * component keep it; this is for apps whose pages don't (the booking pages, plugin apps).
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
 */
export async function createServerViteConfig(options: ServerViteConfigOptions = {}): Promise<any> {
    const { createViteConfig } = await import("@rapidrest/react/vite");
    const { default: tailwindcss } = await import("@tailwindcss/vite");
    const stylesheets: AppStylesheet[] = [
        // The booking pages import no shell that brings the web client's stylesheet, so they get it here.
        { appDir: "apps/book", css: WEB_CLIENT_APP_CSS },
        ...(options.stylesheets ?? []),
    ];
    const config: any = await createViteConfig({
        appDir: [...CORE_APP_DIRS, ...(options.extraAppDirs ?? [])],
        ...(options.outDir ? { outDir: options.outDir } : {}),
        plugins: [appStylesheetPlugin(stylesheets), tailwindcss()],
    });
    return {
        ...config,
        resolve: {
            ...config.resolve,
            dedupe: ["react", "react-dom"],
        },
    };
}
