///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { collectPackages, collectServerInfo, readPackageJson } from "../../src/diagnostics/serverInfo.js";

describe("serverInfo", () => {
    let root: string;

    async function install(name: string, manifest: object | string) {
        const dir = path.join(root, "node_modules", name);
        await mkdir(dir, { recursive: true });
        await writeFile(path.join(dir, "package.json"), typeof manifest === "string" ? manifest : JSON.stringify(manifest));
    }

    beforeEach(async () => {
        root = await mkdtemp(path.join(os.tmpdir(), "pkgs-"));
    });

    afterEach(async () => {
        await rm(root, { recursive: true, force: true });
    });

    it("reads a package.json, or nothing when it is missing or broken", async () => {
        await writeFile(path.join(root, "package.json"), '{"name":"server","version":"1.2.3"}');
        expect(await readPackageJson(path.join(root, "package.json"))).toEqual({ name: "server", version: "1.2.3" });
        expect(await readPackageJson(path.join(root, "nope.json"))).toBeUndefined();
        await writeFile(path.join(root, "bad.json"), "{");
        expect(await readPackageJson(path.join(root, "bad.json"))).toBeUndefined();
    });

    it("describes the server process", () => {
        const now = new Date("2026-09-26T12:00:00Z");
        const info = collectServerInfo({ name: "server", version: "1.0.0" }, now);
        expect(info).toMatchObject({
            nodeVersion: process.version,
            v8Version: process.versions.v8,
            packageName: "server",
            packageVersion: "1.0.0",
            platform: process.platform,
            arch: process.arch,
            hostname: os.hostname(),
            pid: process.pid,
        });
        expect(new Date(info.startedAt).getTime()).toBe(now.getTime() - info.uptimeSeconds * 1000);
    });

    it("copes with no package.json and no NODE_ENV", () => {
        const before = process.env.NODE_ENV;
        delete process.env.NODE_ENV;
        try {
            expect(collectServerInfo(undefined)).toMatchObject({ packageName: "", packageVersion: "", nodeEnv: "" });
        } finally {
            if (before !== undefined) process.env.NODE_ENV = before;
        }
    });

    it("lists the installed packages, scoped ones included, sorted, with the direct ones marked", async () => {
        await install("zeta", { name: "zeta", version: "3.0.0" });
        await install("alpha", { name: "alpha", version: "1.0.0" });
        await install("@scope/lib", { name: "@scope/lib", version: "2.0.0" });
        await install("nameless", { version: "0.1.0" });
        await install("versionless", { name: "versionless" });
        await install("broken", "{");
        await mkdir(path.join(root, "node_modules", ".bin"), { recursive: true });
        await mkdir(path.join(root, "node_modules", "@scope", ".cache"), { recursive: true });
        await writeFile(path.join(root, "node_modules", "a-file"), "x");

        const packages = await collectPackages(root, {
            dependencies: { alpha: "^1" },
            devDependencies: { "@scope/lib": "^2" },
            optionalDependencies: { nameless: "^0" },
        });
        expect(packages).toEqual([
            { name: "@scope/lib", version: "2.0.0", direct: true },
            { name: "alpha", version: "1.0.0", direct: true },
            { name: "nameless", version: "0.1.0", direct: true },
            { name: "zeta", version: "3.0.0", direct: false },
        ]);
    });

    it("lists nothing when there is no node_modules", async () => {
        expect(await collectPackages(root, undefined)).toEqual([]);
    });
});
