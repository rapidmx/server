///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import viteConfig from "../../vite.config.js";
import fs from "fs";
import { appStylesheetPlugin, CORE_APP_DIRS, createServerViteConfig, webClientSourceAlias } from "../../src/lib/serverViteConfig.js";

/** The hydration entry inputs a config's `rapidrest-hydration` plugin discovers. */
function hydrationInputs(config: any): string[] {
    const plugin = config.plugins.flat().find((candidate: any) => candidate?.name === "rapidrest-hydration");
    return Object.keys(plugin.options({}).input);
}

describe("serverViteConfig", () => {
    it("builds the core apps for the image, deduping React and adding no stylesheets of its own", async () => {
        const config = await viteConfig();
        expect(config.resolve.dedupe).toEqual(["react", "react-dom"]);
        expect(config.resolve.alias).toEqual([webClientSourceAlias()]);
        expect(config.build.outDir).toBe("dist/public");
        // reflect-metadata (CommonJS) must run before @peculiar/x509's tsyringe (ESM), or every crypto page is blank.
        expect(config.build.rolldownOptions.output.strictExecutionOrder).toBe(true);
        const inputs = hydrationInputs(config);
        for (const dir of CORE_APP_DIRS) {
            expect(inputs.some((input) => input.startsWith(`${dir}/`)), dir).toBe(true);
        }
        const stylesheets = config.plugins.flat().find((candidate: any) => candidate?.name === "rapidmx-app-stylesheets");
        expect(stylesheets.transform("hydrate();", "\0rapidrest-entry:node_modules/@rapidmx/web-client/apps/www/index.tsx")).toBeUndefined();
        // Booking pages moved to @rapidmx/booking-plugin, so the image builds no repo-local apps.
        expect(inputs.filter((input) => input.startsWith("apps/"))).toEqual([]);
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

    it("resolves the web client's package exports to its app sources, leaving its stylesheet export alone", () => {
        const { find, replacement } = webClientSourceAlias();
        const resolved = "@rapidmx/web-client/shared/components/settings/layout/SettingsShell.js".replace(find, replacement);
        expect(fs.existsSync(`${resolved}.tsx`)).toBe(true);
        expect(find.test("@rapidmx/web-client/shared/styles/app.css")).toBe(false);
        expect(find.test("@rapidmx/react-shared/util/api.js")).toBe(false);
    });

    it("only adds stylesheets to hydration entries of their own app directory", () => {
        const plugin = appStylesheetPlugin([{ appDir: "apps\\book", css: "a.css" }]);
        expect(plugin.transform("x", "\0rapidrest-entry:apps/bookings/index.tsx")).toBeUndefined();
        expect(plugin.transform("x", "apps/book/index.tsx")).toBeUndefined();
        expect(plugin.transform("x", "\0rapidrest-entry:apps/book/[slug].tsx").code).toMatch(/a\.css";\nx$/);
    });
});
