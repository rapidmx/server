///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";
import * as uuid from "uuid";
import { PluginClassLoader, pluginPackagePrefix } from "../../src/plugins/PluginClassLoader.js";

describe("PluginClassLoader", () => {
    let dir: string;

    beforeEach(() => {
        dir = path.join(process.cwd(), `tmp-classloader-${uuid.v4()}`);
        fs.mkdirSync(path.join(dir, "base", "routes"), { recursive: true });
        fs.writeFileSync(path.join(dir, "base", "routes", "Own.mjs"), "export class OwnRoute {}\n");
        fs.writeFileSync(path.join(dir, "good.mjs"), "export class EasRoute {}\nexport class DeviceModel {}\n");
        fs.writeFileSync(path.join(dir, "broken.mjs"), "throw new Error('kaboom');\n");
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    const plugin = (name: string, file: string) => ({
        name,
        version: "1.0.0",
        manifest: { apiVersion: 1, displayName: name },
        entryUrl: pathToFileURL(path.join(dir, file)).href,
    });

    it("prefixes a plugin's classes with its sanitized package name", () => {
        expect(pluginPackagePrefix("@rapidmx/active-sync")).toBe("plugins.rapidmx_active_sync");
        expect(pluginPackagePrefix("plain")).toBe("plugins.plain");
    });

    it("loads the server's own classes and then each plugin's exports, skipping a plugin that fails to import", async () => {
        const logger = { info: vi.fn(), error: vi.fn() };
        const loader = new PluginClassLoader(path.join(dir, "base"), [], [plugin("@rapidmx/good", "good.mjs"), plugin("@rapidmx/broken", "broken.mjs")], logger);
        await loader.load();

        const names = [...loader.getClasses().keys()];
        expect(names).toEqual(expect.arrayContaining(["routes.OwnRoute", "plugins.rapidmx_good.EasRoute", "plugins.rapidmx_good.DeviceModel"]));
        expect(names.some((name) => name.startsWith("plugins.rapidmx_broken"))).toBe(false);
        expect(loader.loaded.map((p) => p.name)).toEqual(["@rapidmx/good"]);
        expect(loader.errors).toEqual([{ name: "@rapidmx/broken", message: expect.stringMatching(/failed to load: kaboom/) }]);
        expect(logger.error).toHaveBeenCalled();
    });

    it("loads plugins once, not again for each subdirectory it scans, reporting once that it's loading them", async () => {
        const onPluginsLoaded = vi.fn(() => expect(loader.loaded).toHaveLength(0));
        const loader = new PluginClassLoader(path.join(dir, "base"), undefined, [plugin("@rapidmx/good", "good.mjs")], undefined, onPluginsLoaded);
        await loader.load();
        expect(loader.loaded).toHaveLength(1);
        expect(onPluginsLoaded).toHaveBeenCalledTimes(1);
    });

    it("runs afterLoad once, after the server's own and the plugins' classes are all loaded", async () => {
        const loader = new PluginClassLoader(path.join(dir, "base"), undefined, [plugin("@rapidmx/good", "good.mjs")]);
        const seen: string[][] = [];
        loader.afterLoad = vi.fn(async (classes: Map<string, any>) => void seen.push([...classes.keys()]));
        await loader.load();
        expect(loader.afterLoad).toHaveBeenCalledTimes(1);
        expect(seen[0]).toEqual(expect.arrayContaining(["routes.OwnRoute", "plugins.rapidmx_good.DeviceModel"]));
    });

    it("doesn't report loading plugins when there are none", async () => {
        const onPluginsLoaded = vi.fn();
        await new PluginClassLoader(path.join(dir, "base"), undefined, [], undefined, onPluginsLoaded).load();
        expect(onPluginsLoaded).not.toHaveBeenCalled();
    });
});
