///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
// A plugin's `onPurge` hook: found in its package's `./purge` export, run from a scratch install with a timeout.
import fs from "fs";
import os from "os";
import path from "path";
import { hasPurgeHook, InstallingPurgeHookRunner, purgeHookTarget, type PluginPurgeContext } from "../../src/plugins/PluginPurgeHook.js";
import { AbortPurgeError, isAbortPurge } from "../../src/plugins/PluginPurgeTypes.js";

let root: string;
const PLUGIN = { name: "@rapidmx/notes-plugin", packageVersion: "1.2.3", integrity: "sha512-x" };
const context = { plugin: { name: PLUGIN.name, version: "1.2.3" }, models: [], connection: () => undefined, config: { get: () => undefined }, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } };

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-purge-hook-"));
});

afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
});

/** An installer that "installs" the plugin by writing its package.json (with `exports`) into the scratch directory. */
function installerWith(pkg: Record<string, unknown>, installed: boolean = true) {
    const dirs: string[] = [];
    const create = (dir: string) => ({
        install: vi.fn(async (desired: any[]) => {
            dirs.push(dir);
            if (!installed) {
                return { installed: [], errors: [{ name: desired[0].name, message: "The package was not installed." }] };
            }
            const packageDir = path.join(dir, "node_modules", ...desired[0].name.split("/"));
            fs.mkdirSync(packageDir, { recursive: true });
            fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({ name: desired[0].name, version: desired[0].packageVersion, ...pkg }));
            fs.writeFileSync(path.join(packageDir, "purge.js"), "");
            return { installed: [{ name: desired[0].name, version: desired[0].packageVersion, packageDir }], errors: [] };
        }),
    });
    return { create, dirs };
}

describe("finding the hook", () => {
    it("reads the ./purge export of a package", () => {
        expect(purgeHookTarget({ exports: { "./purge": "./dist/purge.js" } })).toBe("./dist/purge.js");
        expect(purgeHookTarget({ exports: { "./purge": { import: "./dist/purge.mjs", default: "./x.js" } } })).toBe("./dist/purge.mjs");
        expect(purgeHookTarget({ exports: { "./purge": { default: "./dist/purge.js" } } })).toBe("./dist/purge.js");
        expect(purgeHookTarget({ exports: { "./mongo": "./dist/mongo.js" } })).toBeUndefined();
        expect(purgeHookTarget({})).toBeUndefined();
        expect(purgeHookTarget(undefined)).toBeUndefined();
    });

    it("tells whether an installed package has one", () => {
        fs.mkdirSync(path.join(root, "with"));
        fs.writeFileSync(path.join(root, "with", "package.json"), JSON.stringify({ exports: { "./purge": "./purge.js" } }));
        fs.mkdirSync(path.join(root, "without"));
        fs.writeFileSync(path.join(root, "without", "package.json"), JSON.stringify({ exports: { "./mongo": "./mongo.js" } }));
        fs.mkdirSync(path.join(root, "broken"));
        fs.writeFileSync(path.join(root, "broken", "package.json"), "{not json");
        expect(hasPurgeHook(path.join(root, "with"))).toBe(true);
        expect(hasPurgeHook(path.join(root, "without"))).toBe(false);
        expect(hasPurgeHook(path.join(root, "broken"))).toBe(false);
        expect(hasPurgeHook(path.join(root, "missing"))).toBe(false);
        expect(hasPurgeHook(undefined)).toBe(false);
    });
});

describe("AbortPurgeError", () => {
    it("is recognised by class, by name and by flag", () => {
        expect(isAbortPurge(new AbortPurgeError("no"))).toBe(true);
        expect(new AbortPurgeError("no").name).toBe("AbortPurgeError");
        expect(isAbortPurge(Object.assign(new Error("no"), { name: "AbortPurgeError" }))).toBe(true);
        expect(isAbortPurge(Object.assign(new Error("no"), { abortPurge: true }))).toBe(true);
        expect(isAbortPurge(new Error("no"))).toBe(false);
        expect(isAbortPurge(undefined)).toBe(false);
        expect(isAbortPurge("AbortPurgeError")).toBe(false);
    });
});

describe("InstallingPurgeHookRunner", () => {
    it("installs the plugin into a scratch folder, runs its onPurge with the context and a signal, then deletes the folder", async () => {
        const installer = installerWith({ exports: { "./purge": "./purge.js" } });
        const onPurge = vi.fn(async (ctx: PluginPurgeContext) => {
            expect(ctx.signal.aborted).toBe(false);
        });
        const imported: string[] = [];
        const runner = new InstallingPurgeHookRunner(installer.create, root, async (url) => {
            imported.push(url);
            return { onPurge };
        });

        expect(await runner.run(PLUGIN, context, 5000)).toEqual({ ran: true });

        expect(onPurge).toHaveBeenCalledWith(expect.objectContaining({ plugin: context.plugin, signal: expect.any(AbortSignal) }));
        expect(imported).toHaveLength(1);
        expect(imported[0]).toMatch(/^file:\/\/.*\/node_modules\/@rapidmx\/notes-plugin\/purge\.js$/);
        expect(installer.dirs).toEqual([runner.scratchDir(PLUGIN.name)]);
        expect(runner.scratchDir(PLUGIN.name)).toBe(path.join(root, "rapidmx_notes-plugin"));
        expect(fs.existsSync(runner.scratchDir(PLUGIN.name))).toBe(false);
    });

    it("accepts a default export that is the function, or an object with onPurge", async () => {
        const installer = installerWith({ exports: { "./purge": "./purge.js" } });
        const fn = vi.fn();
        await new InstallingPurgeHookRunner(installer.create, root, async () => ({ default: fn })).run(PLUGIN, context, 5000);
        const method = vi.fn();
        await new InstallingPurgeHookRunner(installer.create, root, async () => ({ default: { onPurge: method } })).run(PLUGIN, context, 5000);
        expect(fn).toHaveBeenCalledTimes(1);
        expect(method).toHaveBeenCalledTimes(1);
    });

    it("runs nothing for a package with no hook", async () => {
        const imports = vi.fn();
        const runner = new InstallingPurgeHookRunner(installerWith({ exports: { "./mongo": "./mongo.js" } }).create, root, imports);
        expect(await runner.run(PLUGIN, context, 5000)).toEqual({ ran: false });
        expect(imports).not.toHaveBeenCalled();
    });

    it("fails - and cleans up - when the module has no onPurge, or the plugin won't install", async () => {
        const installer = installerWith({ exports: { "./purge": "./purge.js" } });
        const noFunction = new InstallingPurgeHookRunner(installer.create, root, async () => ({}));
        await expect(noFunction.run(PLUGIN, context, 5000)).rejects.toThrow("The plugin's ./purge entry point exports no onPurge function.");
        expect(fs.existsSync(noFunction.scratchDir(PLUGIN.name))).toBe(false);

        const failing = new InstallingPurgeHookRunner(installerWith({}, false).create, root);
        await expect(failing.run(PLUGIN, context, 5000)).rejects.toThrow("The package was not installed.");
        const silent = new InstallingPurgeHookRunner(() => ({ install: async () => ({ installed: [], errors: [] }) }), root);
        await expect(silent.run(PLUGIN, context, 5000)).rejects.toThrow(/could not be installed to run its purge hook/);
    });

    it("passes on whatever the hook throws, so an AbortPurgeError still aborts the purge", async () => {
        const installer = installerWith({ exports: { "./purge": "./purge.js" } });
        const runner = new InstallingPurgeHookRunner(installer.create, root, async () => ({
            onPurge: async () => {
                throw new AbortPurgeError("a customer still needs this");
            },
        }));
        const error: any = await runner.run(PLUGIN, context, 5000).catch((err) => err);
        expect(isAbortPurge(error)).toBe(true);
        expect(error.message).toBe("a customer still needs this");
        expect(fs.existsSync(runner.scratchDir(PLUGIN.name))).toBe(false);
    });

    it("stops a hook that runs too long, telling it through the signal", async () => {
        const installer = installerWith({ exports: { "./purge": "./purge.js" } });
        let signal: AbortSignal | undefined;
        const runner = new InstallingPurgeHookRunner(installer.create, root, async () => ({
            onPurge: (ctx: PluginPurgeContext) => {
                signal = ctx.signal;
                return new Promise<void>(() => undefined);
            },
        }));
        await expect(runner.run(PLUGIN, context, 30)).rejects.toThrow("The plugin's onPurge hook took longer than 30ms and was stopped.");
        expect(signal!.aborted).toBe(true);
        expect(fs.existsSync(runner.scratchDir(PLUGIN.name))).toBe(false);
    });

    it("stops an install that takes too long, and threads its own AbortSignal into the install call so the underlying npm process is actually killed rather than merely abandoned", async () => {
        let signal: AbortSignal | undefined;
        const runner = new InstallingPurgeHookRunner(
            () => ({
                install: (_desired, sig) => {
                    signal = sig;
                    return new Promise<any>(() => undefined);
                },
            }),
            root,
        );
        await expect(runner.run(PLUGIN, context, 30)).rejects.toThrow(/Installing @rapidmx\/notes-plugin@1\.2\.3 to run its purge hook took longer than/);
        expect(signal).toBeInstanceOf(AbortSignal);
        expect(signal!.aborted).toBe(true);
    });

    it("imports a real hook module from the installed package", async () => {
        const installer = installerWith({ exports: { "./purge": "./purge.mjs" } });
        const create = (dir: string) => {
            const inner = installer.create(dir);
            return {
                install: async (desired: any[]) => {
                    const result: any = await inner.install(desired);
                    fs.writeFileSync(path.join(result.installed[0].packageDir, "purge.mjs"), `export async function onPurge(ctx) { globalThis.__purgeHookRan = ctx.plugin.name; }`);
                    return result;
                },
            };
        };
        const runner = new InstallingPurgeHookRunner(create, root);
        expect(await runner.run(PLUGIN, context, 5000)).toEqual({ ran: true });
        expect((globalThis as any).__purgeHookRan).toBe("@rapidmx/notes-plugin");
        delete (globalThis as any).__purgeHookRan;
    });
});
