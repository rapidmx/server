///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import path from "path";
import viteConfig from "../../vite.config.js";
import { appStylesheetPlugin, CORE_APP_DIRS, createServerViteConfig, WEB_CLIENT_APP_CSS } from "../../src/lib/serverViteConfig.js";

/** The hydration entry inputs a config's `rapidrest-hydration` plugin discovers. */
function hydrationInputs(config: any): string[] {
    const plugin = config.plugins.flat().find((candidate: any) => candidate?.name === "rapidrest-hydration");
    return Object.keys(plugin.options({}).input);
}

describe("serverViteConfig", () => {
    it("builds the core apps for the image, deduping React and adding the web client's stylesheet to the booking pages", async () => {
        const config = await viteConfig();
        expect(config.resolve.dedupe).toEqual(["react", "react-dom"]);
        expect(config.build.outDir).toBe("dist/public");
        const inputs = hydrationInputs(config);
        for (const dir of CORE_APP_DIRS) {
            expect(inputs.some((input) => input.startsWith(`${dir}/`)), dir).toBe(true);
        }
        const stylesheets = config.plugins.flat().find((candidate: any) => candidate?.name === "rapidmx-app-stylesheets");
        const result = stylesheets.transform("hydrate();", "\0rapidrest-entry:apps/book/index.tsx");
        expect(result.code).toBe(`import ${JSON.stringify(path.resolve(WEB_CLIENT_APP_CSS).replace(/\\/g, "/"))};\nhydrate();`);
    });

    it("adds extra app directories, their stylesheets and the output directory", async () => {
        const config = await createServerViteConfig({
            extraAppDirs: ["test/fixtures/ui-plugin/apps/hello"],
            outDir: "tmp-out",
            stylesheets: [{ appDir: "test/fixtures/ui-plugin/apps/hello/", css: "/abs/plugin.css" }],
        });
        expect(config.build.outDir).toBe("tmp-out");
        expect(hydrationInputs(config)).toContain("test/fixtures/ui-plugin/apps/hello/index.tsx");
        const plugin = config.plugins.flat().find((candidate: any) => candidate?.name === "rapidmx-app-stylesheets");
        expect(plugin.transform("x", "\0rapidrest-entry:test/fixtures/ui-plugin/apps/hello/index.tsx").code).toMatch(/plugin\.css";\nx$/);
    });

    it("only adds stylesheets to hydration entries of their own app directory", () => {
        const plugin = appStylesheetPlugin([{ appDir: "apps\\book", css: "a.css" }]);
        expect(plugin.transform("x", "\0rapidrest-entry:apps/bookings/index.tsx")).toBeUndefined();
        expect(plugin.transform("x", "apps/book/index.tsx")).toBeUndefined();
        expect(plugin.transform("x", "\0rapidrest-entry:apps/book/[slug].tsx").code).toMatch(/a\.css";\nx$/);
    });
});
