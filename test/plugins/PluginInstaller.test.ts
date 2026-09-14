///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import * as uuid from "uuid";
import { findPackageDir, PluginInstaller, runNpm } from "../../src/plugins/PluginInstaller.js";

const MANIFEST = { plugin: { apiVersion: 1, displayName: "Test plugin" } };

interface FakePackage {
    version?: string;
    rapidmx?: any;
    exports?: any;
    integrity?: string;
    /** Writes a nested copy of this shared peer, as if the plugin bundled its own. */
    ownPeer?: string;
    skipEntryFile?: boolean;
}

/** An npm stand-in that "installs" the given packages into `<cwd>/node_modules` and writes a lockfile. */
function fakeNpm(packages: Record<string, FakePackage>) {
    return vi.fn(async (_args: string[], cwd: string) => {
        const lock: any = { packages: {} };
        for (const [name, pkg] of Object.entries(packages)) {
            const dir = path.join(cwd, "node_modules", ...name.split("/"));
            fs.mkdirSync(path.join(dir, "dist"), { recursive: true });
            fs.writeFileSync(
                path.join(dir, "package.json"),
                JSON.stringify({
                    name,
                    version: pkg.version ?? "1.0.0",
                    rapidmx: "rapidmx" in pkg ? pkg.rapidmx : MANIFEST,
                    exports: pkg.exports ?? { "./mongo": { import: "./dist/mongo.js" }, "./sql": "./dist/sql.js" },
                }),
            );
            if (!pkg.skipEntryFile) {
                fs.writeFileSync(path.join(dir, "dist", "mongo.js"), "export class Thing {}\n");
                fs.writeFileSync(path.join(dir, "dist", "sql.js"), "export class Thing {}\n");
            }
            if (pkg.ownPeer) {
                const peerDir = path.join(dir, "node_modules", ...pkg.ownPeer.split("/"));
                fs.mkdirSync(peerDir, { recursive: true });
                fs.writeFileSync(path.join(peerDir, "package.json"), JSON.stringify({ name: pkg.ownPeer }));
            }
            lock.packages[`node_modules/${name}`] = { integrity: pkg.integrity ?? `sha512-${name}` };
        }
        fs.writeFileSync(path.join(cwd, "package-lock.json"), JSON.stringify(lock));
    });
}

describe("PluginInstaller", () => {
    const appRoot = process.cwd();
    let dir: string;

    beforeEach(() => {
        // Inside the server's directory, as in production, so shared peers resolve to the server's own copies.
        dir = path.join(appRoot, `tmp-plugins-${uuid.v4()}`);
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    function installer(npm: any, extra: Record<string, any> = {}) {
        return new PluginInstaller({ dir, appRoot, registry: "https://registry.example.com", datastore: "mongo", runNpm: npm, ...extra });
    }

    it("installs plugins with safe npm flags and returns their entry points", async () => {
        const npm = fakeNpm({ "@rapidmx/one": {} });
        const result = await installer(npm).install([{ name: "@rapidmx/one", packageVersion: "1.0.0", integrity: "sha512-@rapidmx/one" }]);

        expect(result.errors).toEqual([]);
        expect(result.installed).toHaveLength(1);
        expect(result.installed[0]).toEqual(expect.objectContaining({ name: "@rapidmx/one", version: "1.0.0", manifest: expect.objectContaining({ displayName: "Test plugin" }) }));
        expect(fileURLToPath(result.installed[0].entryUrl)).toBe(path.join(fs.realpathSync(dir), "node_modules", "@rapidmx", "one", "dist", "mongo.js"));
        expect(npm).toHaveBeenCalledWith(
            expect.arrayContaining(["install", "--omit=dev", "--omit=peer", "--legacy-peer-deps", "--ignore-scripts", "--registry", "https://registry.example.com"]),
            dir,
        );
        expect(JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).dependencies).toEqual({ "@rapidmx/one": "1.0.0" });
    });

    it("skips npm when the plugin set is unchanged, and reinstalls when it changes", async () => {
        const npm = fakeNpm({ "@rapidmx/one": {} });
        await installer(npm).install([{ name: "@rapidmx/one", packageVersion: "1.0.0" }]);
        await installer(npm).install([{ name: "@rapidmx/one", packageVersion: "1.0.0" }]);
        expect(npm).toHaveBeenCalledTimes(1);

        const upgraded = fakeNpm({ "@rapidmx/one": { version: "1.1.0" } });
        const result = await installer(upgraded).install([{ name: "@rapidmx/one", packageVersion: "1.1.0" }]);
        expect(upgraded).toHaveBeenCalledTimes(1);
        expect(result.installed[0].version).toBe("1.1.0");
    });

    it("uses the sql entry point for a SQL server, including a plain-string export", async () => {
        const result = await installer(fakeNpm({ "@rapidmx/one": {} }), { datastore: "sql" }).install([{ name: "@rapidmx/one", packageVersion: "1.0.0" }]);
        expect(result.installed[0].entryUrl).toMatch(/dist\/sql\.js$/);
    });

    it.each<[string, FakePackage, any, RegExp]>([
        ["a version mismatch", { version: "2.0.0" }, {}, /Expected version 1\.0\.0, but 2\.0\.0/],
        ["an integrity mismatch", { integrity: "sha512-other" }, { integrity: "sha512-expected" }, /integrity hash doesn't match/],
        ["a package that isn't a plugin", { rapidmx: undefined }, {}, /not a RapidMX plugin/],
        ["a missing entry point export", { exports: { ".": "./dist/index.js" } }, {}, /no \.\/mongo entry point/],
        ["a missing entry point file", { skipEntryFile: true }, {}, /entry point \(\.\/dist\/mongo\.js\) is missing/],
        ["its own copy of a shared peer", { ownPeer: "@rapidrest/service-core" }, {}, /own copy of @rapidrest\/service-core/],
    ])("reports and skips %s while loading the others", async (_label, pkg, desired, message) => {
        const npm = fakeNpm({ "@rapidmx/bad": pkg, "@rapidmx/good": {} });
        const result = await installer(npm).install([
            { name: "@rapidmx/bad", packageVersion: "1.0.0", ...desired },
            { name: "@rapidmx/good", packageVersion: "1.0.0" },
        ]);
        expect(result.installed.map((p) => p.name)).toEqual(["@rapidmx/good"]);
        expect(result.errors).toEqual([{ name: "@rapidmx/bad", message: expect.stringMatching(message) }]);
    });

    it("reports a package npm didn't install", async () => {
        const result = await installer(fakeNpm({})).install([{ name: "@rapidmx/ghost", packageVersion: "1.0.0" }]);
        expect(result.errors).toEqual([{ name: "@rapidmx/ghost", message: "The package was not installed." }]);
    });

    it("reports every plugin when npm fails, and retries on the next start", async () => {
        const failing = vi.fn(async () => {
            throw new Error("npm install failed: 404 Not Found");
        });
        const result = await installer(failing).install([
            { name: "@rapidmx/one", packageVersion: "1.0.0" },
            { name: "@rapidmx/two", packageVersion: "1.0.0" },
        ]);
        expect(result.installed).toEqual([]);
        expect(result.errors.map((e) => e.name)).toEqual(["@rapidmx/one", "@rapidmx/two"]);
        expect(result.errors[0].message).toMatch(/404/);

        const npm = fakeNpm({ "@rapidmx/one": {}, "@rapidmx/two": {} });
        await installer(npm).install([
            { name: "@rapidmx/one", packageVersion: "1.0.0" },
            { name: "@rapidmx/two", packageVersion: "1.0.0" },
        ]);
        expect(npm).toHaveBeenCalledTimes(1);
    });

    it("installs a local tarball source without checking its version or integrity", async () => {
        const npm = fakeNpm({ "@rapidmx/one": { version: "9.9.9", integrity: "sha512-local" } });
        const result = await installer(npm, { sources: { "@rapidmx/one": "./one.tgz" } }).install([
            { name: "@rapidmx/one", packageVersion: "1.0.0", integrity: "sha512-registry" },
        ]);
        expect(result.errors).toEqual([]);
        expect(JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).dependencies["@rapidmx/one"]).toBe(`file:${path.resolve("./one.tgz")}`);
    });

    it("writes a registry token to a private .npmrc, and removes it when the token is gone", async () => {
        await installer(fakeNpm({ "@rapidmx/one": {} }), { registryToken: "secret" }).install([{ name: "@rapidmx/one", packageVersion: "1.0.0" }]);
        expect(fs.readFileSync(path.join(dir, ".npmrc"), "utf8")).toBe("//registry.example.com/:_authToken=secret\n");

        await installer(fakeNpm({ "@rapidmx/one": {} }), { registry: "https://other.example.com" }).install([{ name: "@rapidmx/one", packageVersion: "1.0.0" }]);
        expect(fs.existsSync(path.join(dir, ".npmrc"))).toBe(false);
    });

    it("removes installed plugins when none are enabled, without running npm", async () => {
        await installer(fakeNpm({ "@rapidmx/one": {} })).install([{ name: "@rapidmx/one", packageVersion: "1.0.0" }]);
        const npm = vi.fn();
        expect(await installer(npm).install([])).toEqual({ installed: [], errors: [] });
        expect(npm).not.toHaveBeenCalled();
        expect(fs.existsSync(path.join(dir, "node_modules"))).toBe(false);
    });

    it("finds packages the way Node resolves them", () => {
        expect(findPackageDir(appRoot, "@rapidrest/core")).toBe(fs.realpathSync(path.join(appRoot, "node_modules", "@rapidrest", "core")));
        expect(findPackageDir(appRoot, "@rapidmx/definitely-not-installed")).toBeUndefined();
    });

    it("runs npm and reports its output when it fails", async () => {
        await expect(runNpm(["--version"], appRoot)).resolves.toBeUndefined();
        await expect(runNpm(["definitely-not-a-command"], appRoot)).rejects.toThrow(/npm definitely-not-a-command failed/);
    }, 60_000);
});
