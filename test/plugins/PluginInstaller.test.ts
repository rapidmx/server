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
    /** The plugin's dependencies, as recorded in the lockfile. */
    dependencies?: Record<string, string>;
}

/** An npm stand-in that "installs" the given packages into `<cwd>/node_modules` and writes a lockfile. `other` adds
 * further lockfile entries (by lockfile path), each installed as a bare package. */
function fakeNpm(packages: Record<string, FakePackage>, other: Record<string, any> = {}) {
    return vi.fn(async (_args: string[], cwd: string) => {
        const lock: any = { packages: {} };
        for (const [key, entry] of Object.entries(other)) {
            lock.packages[key] = entry;
            if (entry.peer) {
                // --omit=peer: recorded, not installed.
                continue;
            }
            const dir = path.join(cwd, ...key.split("/"));
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: key.slice(key.lastIndexOf("node_modules/") + 13), version: "1.0.0" }));
        }
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
            lock.packages[`node_modules/${name}`] = { integrity: pkg.integrity ?? `sha512-${name}`, dependencies: pkg.dependencies };
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
            600_000,
        );
        expect(JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).dependencies).toEqual({ "@rapidmx/one": "1.0.0" });
    });

    it("skips npm when the plugin set is unchanged, and reinstalls when it changes", async () => {
        const npm = fakeNpm({ "@rapidmx/one": {} });
        await installer(npm).install([{ name: "@rapidmx/one", packageVersion: "1.0.0", integrity: "sha512-@rapidmx/one" }]);
        await installer(npm).install([{ name: "@rapidmx/one", packageVersion: "1.0.0", integrity: "sha512-@rapidmx/one" }]);
        expect(npm).toHaveBeenCalledTimes(1);

        const upgraded = fakeNpm({ "@rapidmx/one": { version: "1.1.0" } });
        const result = await installer(upgraded).install([{ name: "@rapidmx/one", packageVersion: "1.1.0", integrity: "sha512-@rapidmx/one" }]);
        expect(upgraded).toHaveBeenCalledTimes(1);
        expect(result.installed[0].version).toBe("1.1.0");
    });

    it("returns each plugin's package directory, integrity and UI apps with their source and compiled directories", async () => {
        const ui = {
            apps: [
                { id: "book", host: "public", mount: "/book", dir: "apps/book" },
                { id: "booking-types", host: "www", mount: "/settings/booking-types", dir: "apps/settings/booking-types" },
            ],
        };
        const npm = fakeNpm({ "@rapidmx/booking": { rapidmx: { plugin: { ...MANIFEST.plugin, ui } } }, "@rapidmx/plain": {} });
        const result = await installer(npm).install([
            { name: "@rapidmx/booking", packageVersion: "1.0.0", integrity: "sha512-@rapidmx/booking" },
            { name: "@rapidmx/plain", packageVersion: "1.0.0", integrity: "sha512-@rapidmx/plain" },
        ]);
        expect(result.errors).toEqual([]);
        const packageDir = path.join(dir, "node_modules", "@rapidmx", "booking");
        expect(result.installed[0]).toEqual(
            expect.objectContaining({
                packageDir,
                integrity: "sha512-@rapidmx/booking",
                uiApps: [
                    { ...ui.apps[0], sourceDir: path.join(packageDir, "apps", "book"), ssrDir: path.join(packageDir, "dist", "apps", "book") },
                    {
                        ...ui.apps[1],
                        sourceDir: path.join(packageDir, "apps", "settings", "booking-types"),
                        ssrDir: path.join(packageDir, "dist", "apps", "settings", "booking-types"),
                    },
                ],
            }),
        );
        expect(result.installed[1].uiApps).toEqual([]);
    });

    it("uses the sql entry point for a SQL server, including a plain-string export", async () => {
        const result = await installer(fakeNpm({ "@rapidmx/one": {} }), { datastore: "sql" }).install([{ name: "@rapidmx/one", packageVersion: "1.0.0", integrity: "sha512-@rapidmx/one" }]);
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
            { name: "@rapidmx/bad", packageVersion: "1.0.0", integrity: "sha512-@rapidmx/bad", ...desired },
            { name: "@rapidmx/good", packageVersion: "1.0.0", integrity: "sha512-@rapidmx/good" },
        ]);
        expect(result.installed.map((p) => p.name)).toEqual(["@rapidmx/good"]);
        expect(result.errors).toEqual([{ name: "@rapidmx/bad", message: expect.stringMatching(message) }]);
    });

    it("reports a package npm didn't install", async () => {
        const result = await installer(fakeNpm({})).install([{ name: "@rapidmx/ghost", packageVersion: "1.0.0", integrity: "sha512-@rapidmx/ghost" }]);
        expect(result.errors).toEqual([{ name: "@rapidmx/ghost", message: "The package was not installed." }]);
    });

    it("reports every plugin when npm fails, and retries on the next start", async () => {
        const failing = vi.fn(async () => {
            throw new Error("npm install failed: 404 Not Found");
        });
        const result = await installer(failing).install([
            { name: "@rapidmx/one", packageVersion: "1.0.0", integrity: "sha512-@rapidmx/one" },
            { name: "@rapidmx/two", packageVersion: "1.0.0", integrity: "sha512-@rapidmx/two" },
        ]);
        expect(result.installed).toEqual([]);
        expect(result.errors.map((e) => e.name)).toEqual(["@rapidmx/one", "@rapidmx/two"]);
        expect(result.errors[0].message).toMatch(/404/);

        const npm = fakeNpm({ "@rapidmx/one": {}, "@rapidmx/two": {} });
        await installer(npm).install([
            { name: "@rapidmx/one", packageVersion: "1.0.0", integrity: "sha512-@rapidmx/one" },
            { name: "@rapidmx/two", packageVersion: "1.0.0", integrity: "sha512-@rapidmx/two" },
        ]);
        expect(npm).toHaveBeenCalledTimes(1);
    });

    it("still loads previously installed plugins that match what's wanted when npm fails, and marks errors retrying won't fix", async () => {
        const one = { name: "@rapidmx/one", packageVersion: "1.0.0", integrity: "sha512-@rapidmx/one" };
        const two = { name: "@rapidmx/two", packageVersion: "1.0.0", integrity: "sha512-@rapidmx/two" };
        await installer(fakeNpm({ "@rapidmx/one": {}, "@rapidmx/two": {} })).install([one, two]);

        // Upgrading two fails: one is untouched and still loads; two's installed copy is the wrong version.
        const timeout = vi.fn(async () => Promise.reject(new Error("npm install failed: ETIMEDOUT")));
        const result = await installer(timeout, { npmTimeoutMs: 5_000 }).install([one, { ...two, packageVersion: "1.1.0" }]);
        expect(timeout).toHaveBeenCalledWith(expect.any(Array), dir, 5_000);
        expect(result.installed.map((p) => p.name)).toEqual(["@rapidmx/one"]);
        expect(result.errors).toEqual([{ name: "@rapidmx/two", message: "npm install failed: ETIMEDOUT" }]);
        expect(result.installFailures).toBe(1);
        expect(result.installFailurePermanent).toBe(false);

        const missing = vi.fn(async () => Promise.reject(new Error("npm install failed: npm error code E404")));
        const permanent = await installer(missing).install([one, { ...two, packageVersion: "1.1.0" }]);
        expect(permanent.installFailures).toBe(2);
        expect(permanent.installFailurePermanent).toBe(true);
        // Still not recorded as installed, so the next start tries npm again.
        const retried = fakeNpm({ "@rapidmx/one": {}, "@rapidmx/two": { version: "1.1.0" } });
        expect((await installer(retried).install([one, { ...two, packageVersion: "1.1.0" }])).installed).toHaveLength(2);
        expect(retried).toHaveBeenCalledTimes(1);
    });

    it("installs a registry plugin with no recorded integrity hash when require_integrity is off", async () => {
        const npm = fakeNpm({ "@rapidmx/one": {}, "@rapidmx/two": { integrity: "sha512-other" } });
        const result = await installer(npm, { requireIntegrity: false }).install([
            { name: "@rapidmx/one", packageVersion: "1.0.0" },
            { name: "@rapidmx/two", packageVersion: "1.0.0", integrity: "sha512-@rapidmx/two" },
        ]);
        expect(result.installed.map((p) => p.name)).toEqual(["@rapidmx/one"]);
        // A hash that was recorded is still checked.
        expect(result.errors).toEqual([{ name: "@rapidmx/two", message: expect.stringMatching(/integrity hash doesn't match/) }]);
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
        await installer(fakeNpm({ "@rapidmx/one": {} }), { registryToken: "secret" }).install([{ name: "@rapidmx/one", packageVersion: "1.0.0", integrity: "sha512-@rapidmx/one" }]);
        expect(fs.readFileSync(path.join(dir, ".npmrc"), "utf8")).toBe("//registry.example.com/:_authToken=secret\n");

        await installer(fakeNpm({ "@rapidmx/one": {} }), { registry: "https://other.example.com" }).install([{ name: "@rapidmx/one", packageVersion: "1.0.0", integrity: "sha512-@rapidmx/one" }]);
        expect(fs.existsSync(path.join(dir, ".npmrc"))).toBe(false);
    });

    it("points namespaces with their own registry at it in .npmrc, with their tokens, and reinstalls when that changes", async () => {
        const npm = fakeNpm({ "@acme/crm-plugin": {} });
        const namespaces = [
            { name: "@rapidmx" },
            { name: "@acme", registry: "https://npm.acme.test/", token: "acme-token" },
            { name: "@open", registry: "https://npm.open.test" },
        ];
        await installer(npm, { namespaces }).install([{ name: "@acme/crm-plugin", packageVersion: "1.0.0", integrity: "sha512-@acme/crm-plugin" }]);
        expect(fs.readFileSync(path.join(dir, ".npmrc"), "utf8")).toBe(
            "@acme:registry=https://npm.acme.test/\n//npm.acme.test/:_authToken=acme-token\n@open:registry=https://npm.open.test\n",
        );

        await installer(npm, { namespaces: namespaces.slice(0, 2) }).install([{ name: "@acme/crm-plugin", packageVersion: "1.0.0", integrity: "sha512-@acme/crm-plugin" }]);
        expect(npm).toHaveBeenCalledTimes(2);
        expect(fs.readFileSync(path.join(dir, ".npmrc"), "utf8")).not.toContain("@open");
    });

    it("refuses a registry plugin with no recorded integrity hash, installing the others", async () => {
        const npm = fakeNpm({ "@rapidmx/one": {}, "@rapidmx/two": {} });
        const result = await installer(npm).install([
            { name: "@rapidmx/one", packageVersion: "1.0.0" },
            { name: "@rapidmx/two", packageVersion: "1.0.0", integrity: "sha512-@rapidmx/two" },
        ]);
        expect(result.installed.map((p) => p.name)).toEqual(["@rapidmx/two"]);
        expect(result.errors).toEqual([{ name: "@rapidmx/one", message: expect.stringMatching(/No integrity hash was recorded/) }]);
        expect(JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).dependencies).toEqual({ "@rapidmx/two": "1.0.0" });
    });

    it("keeps the lockfile across reinstalls, starting it over only when the registries change", async () => {
        const lockExisted: boolean[] = [];
        const npm = (packages: Record<string, FakePackage>) => {
            const install = fakeNpm(packages);
            return vi.fn(async (args: string[], cwd: string) => {
                lockExisted.push(fs.existsSync(path.join(cwd, "package-lock.json")));
                await install(args, cwd);
            });
        };
        const one = { name: "@rapidmx/one", packageVersion: "1.0.0", integrity: "sha512-@rapidmx/one" };
        const two = { name: "@rapidmx/two", packageVersion: "1.0.0", integrity: "sha512-@rapidmx/two" };
        await installer(npm({ "@rapidmx/one": {} })).install([one]);
        await installer(npm({ "@rapidmx/one": {}, "@rapidmx/two": {} })).install([one, two]);
        fs.rmSync(path.join(dir, "node_modules"), { recursive: true, force: true });
        await installer(npm({ "@rapidmx/one": {}, "@rapidmx/two": {} })).install([one, two]);
        await installer(npm({ "@rapidmx/one": {}, "@rapidmx/two": {} }), { registry: "https://other.example.com" }).install([one, two]);
        expect(lockExisted).toEqual([false, true, true, false]);
    });

    it("counts npm failures in a row until an install succeeds", async () => {
        const failing = vi.fn(async () => Promise.reject(new Error("npm install failed: ETIMEDOUT")));
        const one = [{ name: "@rapidmx/one", packageVersion: "1.0.0", integrity: "sha512-@rapidmx/one" }];
        expect((await installer(failing).install(one)).installFailures).toBe(1);
        expect((await installer(failing).install(one)).installFailures).toBe(2);
        const ok = await installer(fakeNpm({ "@rapidmx/one": {} })).install(one);
        expect(ok.installFailures).toBeUndefined();
        expect(ok.installed).toHaveLength(1);
        expect((await installer(failing).install([{ ...one[0], packageVersion: "1.1.0" }])).installFailures).toBe(1);
    });

    it("rewrites .npmrc on every start, even when nothing is reinstalled", async () => {
        const npm = fakeNpm({ "@rapidmx/one": {} });
        const one = [{ name: "@rapidmx/one", packageVersion: "1.0.0", integrity: "sha512-@rapidmx/one" }];
        await installer(npm, { registryToken: "old" }).install(one);
        if (process.platform !== "win32") {
            fs.chmodSync(path.join(dir, ".npmrc"), 0o644);
        }
        await installer(npm, { registryToken: "new" }).install(one);
        expect(fs.readFileSync(path.join(dir, ".npmrc"), "utf8")).toContain("_authToken=new");
        if (process.platform !== "win32") {
            expect(fs.statSync(path.join(dir, ".npmrc")).mode & 0o777).toBe(0o600);
        }
        await installer(npm).install(one);
        expect(fs.existsSync(path.join(dir, ".npmrc"))).toBe(false);
        expect(npm).toHaveBeenCalledTimes(1);
    });

    it("fails only the plugin that brought a hoisted copy of a shared peer, and removes that copy", async () => {
        const npm = fakeNpm(
            { "@rapidmx/bad": { dependencies: { "@rapidrest/core": "^1.0.0" } }, "@rapidmx/good": {} },
            { "node_modules/@rapidrest/core": { version: "1.0.0" } },
        );
        const desired = ["@rapidmx/bad", "@rapidmx/good"].map((name) => ({ name, packageVersion: "1.0.0", integrity: `sha512-${name}` }));
        for (const run of [1, 2]) {
            const result = await installer(run === 1 ? npm : vi.fn()).install(desired);
            expect(result.installed.map((p) => p.name)).toEqual(["@rapidmx/good"]);
            expect(result.errors).toEqual([
                { name: "@rapidmx/bad", message: expect.stringMatching(/own copy of @rapidrest\/core \(node_modules\/@rapidrest\/core\)/) },
            ]);
            expect(fs.existsSync(path.join(dir, "node_modules", "@rapidrest", "core"))).toBe(false);
        }
    });

    it("fails a plugin whose dependency nests its own copy of a shared peer", async () => {
        const npm = fakeNpm(
            { "@rapidmx/bad": { dependencies: { helper: "^1.0.0" } }, "@rapidmx/good": { dependencies: { helper: "^1.0.0", "@rapidrest/core": "^1.0.0" } } },
            {
                "node_modules/helper": { version: "1.0.0", dependencies: { lodash: "^4.0.0" } },
                "node_modules/lodash": { version: "4.0.0" },
                "node_modules/@rapidmx/bad/node_modules/helper": { version: "2.0.0", dependencies: { "@rapidmx/restapi": "*" } },
                "node_modules/@rapidmx/bad/node_modules/helper/node_modules/@rapidmx/restapi": { version: "0.1.0" },
                "node_modules/@rapidmx/good/node_modules/@rapidrest/core": { version: "1.0.0", peer: true },
            },
        );
        const result = await installer(npm).install(
            ["@rapidmx/bad", "@rapidmx/good"].map((name) => ({ name, packageVersion: "1.0.0", integrity: `sha512-${name}` })),
        );
        expect(result.errors).toEqual([
            {
                name: "@rapidmx/bad",
                message: expect.stringContaining("own copy of @rapidmx/restapi (node_modules/@rapidmx/bad/node_modules/helper/node_modules/@rapidmx/restapi)"),
            },
        ]);
        expect(fs.existsSync(path.join(dir, "node_modules", "@rapidmx", "bad", "node_modules", "helper"))).toBe(true);
    });

    it("removes installed plugins when none are enabled, without running npm", async () => {
        await installer(fakeNpm({ "@rapidmx/one": {} })).install([{ name: "@rapidmx/one", packageVersion: "1.0.0", integrity: "sha512-@rapidmx/one" }]);
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
        await expect(runNpm(["--version"], appRoot, 1)).rejects.toThrow(/npm --version failed: it took longer than 0s/);
    }, 60_000);
});
