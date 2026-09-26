///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import viteConfig from "../../vite.config.js";
import fs from "fs";
import { appStylesheetPlugin, CORE_APP_DIRS, createServerViteConfig, ROUTER_APP_DIRS, webClientSourceAlias } from "../../src/lib/serverViteConfig.js";

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

    it("builds a client router entry for the admin and escrow consoles only", async () => {
        for (const config of [await viteConfig(), await createServerViteConfig({ extraAppDirs: ["test/fixtures/ui-plugin/apps/hello"] })]) {
            const routers = hydrationInputs(config).filter((input) => input.endsWith("/__router"));
            expect(routers.sort()).toEqual([...ROUTER_APP_DIRS].sort().map((dir) => `${dir}/__router`));
            // Their pages keep an entry of their own as well: the manifest record that says which stylesheets a page needs.
            expect(hydrationInputs(config)).toContain("node_modules/@rapidmx/web-client/apps/admin/index.tsx");
        }
        expect(ROUTER_APP_DIRS.every((dir) => CORE_APP_DIRS.includes(dir))).toBe(true);
        expect(ROUTER_APP_DIRS.some((dir) => dir.endsWith("/www"))).toBe(false);
    });

    it("gives React and the icon set chunks of their own, so the app's other chunks can change without invalidating them", async () => {
        const config = await createServerViteConfig();
        const groups = config.build.rolldownOptions.output.codeSplitting.groups;
        const group = (name: string) => groups.find((candidate: any) => candidate.name === name);
        for (const id of ["react", "react-dom", "scheduler"]) {
            for (const separator of ["/", "\\"]) {
                expect(group("react").test.test(`C:${separator}app${separator}node_modules${separator}${id}${separator}index.js`), id + separator).toBe(true);
            }
        }
        expect(group("react").test.test("/app/node_modules/react-icons/hi2/index.mjs")).toBe(false);
        expect(group("react").test.test("/app/node_modules/react-router/index.js")).toBe(false);
        expect(group("icons").test.test("/app/node_modules/react-icons/hi2/index.mjs")).toBe(true);
        expect(group("icons").test.test("C:\\app\\node_modules\\react-icons\\lib\\iconBase.mjs")).toBe(true);
        // Only the compose toolbar uses these, so they stay out of the initial chunks.
        expect(group("icons").test.test("/app/node_modules/react-icons/bs/index.mjs")).toBe(false);
        expect(group("icons").test.test("/app/node_modules/react/index.js")).toBe(false);
        // React is chosen before the icon set where a path could be either.
        expect(group("react").priority).toBeGreaterThan(group("icons").priority);
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
