///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
// Deleting what a server copy keeps on disk for a removed plugin: only inside the plugin directory, never through a link.
import fs from "fs";
import os from "os";
import path from "path";
import { deletePluginFiles, isContained, removeContained, removeContainedAsync } from "../../src/plugins/PluginPurgeFiles.js";

let root: string;

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-purge-files-"));
});

afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
});

const write = (file: string, content: string = "x"): string => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
};

/** Makes a directory link (a junction on Windows, a symlink elsewhere) and returns a function that removes just the link (unlink, not rmdir: rmdir on a symlink is ENOTDIR on Linux). */
function link(target: string, at: string): () => void {
    fs.mkdirSync(path.dirname(at), { recursive: true });
    fs.symlinkSync(target, at, "junction");
    return () => fs.unlinkSync(at);
}

describe("isContained", () => {
    it("is true for the root and anything below it, false for anything else", () => {
        expect(isContained("/a/b", "/a/b")).toBe(true);
        expect(isContained("/a/b", "/a/b/c/d")).toBe(true);
        expect(isContained("/a/b", "/a/bc")).toBe(false);
        expect(isContained("/a/b", "/a")).toBe(false);
        expect(isContained("/a/b", "/a/b/../c")).toBe(false);
    });
});

describe("removeContained", () => {
    it("deletes a folder inside the root, and says when there was nothing there", () => {
        write(path.join(root, "pkg", "deep", "file.txt"));
        expect(removeContained(root, path.join(root, "pkg"))).toBe(true);
        expect(fs.existsSync(path.join(root, "pkg"))).toBe(false);
        expect(removeContained(root, path.join(root, "pkg"))).toBe(false);
    });

    it("refuses the root itself and anything outside it", () => {
        const outside = write(path.join(os.tmpdir(), `outside-${Date.now()}.txt`));
        try {
            expect(() => removeContained(root, root)).toThrow(/isn't inside/);
            expect(() => removeContained(root, outside)).toThrow(/isn't inside/);
            expect(() => removeContained(root, path.join(root, "..", "elsewhere"))).toThrow(/isn't inside/);
            expect(fs.existsSync(outside)).toBe(true);
        } finally {
            fs.rmSync(outside, { force: true });
        }
    });

    it("refuses a target that is a link, leaving both the link and what it points at", () => {
        const elsewhere = path.join(root, "elsewhere");
        const keep = write(path.join(elsewhere, "keep.txt"));
        const unlink = link(elsewhere, path.join(root, "inside", "pkg"));
        try {
            expect(() => removeContained(path.join(root, "inside"), path.join(root, "inside", "pkg"))).toThrow(/is a link/);
            expect(fs.existsSync(keep)).toBe(true);
        } finally {
            unlink();
        }
    });

    it("refuses a target that contains a link, or that sits behind one", () => {
        const elsewhere = path.join(root, "elsewhere");
        const keep = write(path.join(elsewhere, "keep.txt"));
        write(path.join(root, "inside", "pkg", "a.txt"));
        const unlinkInner = link(elsewhere, path.join(root, "inside", "pkg", "inner"));
        try {
            expect(() => removeContained(path.join(root, "inside"), path.join(root, "inside", "pkg"))).toThrow(/is a link/);
            expect(fs.existsSync(path.join(root, "inside", "pkg", "a.txt"))).toBe(true);
        } finally {
            unlinkInner();
        }
        // The root itself is a link: what is "inside" it is really somewhere else.
        const unlinkRoot = link(elsewhere, path.join(root, "linked-root"));
        try {
            expect(() => removeContained(path.join(root, "linked-root"), path.join(root, "linked-root", "keep.txt"))).toThrow(/is a link/);
            // A folder between the root and the target is one.
            fs.mkdirSync(path.join(root, "top"), { recursive: true });
            const unlinkMid = link(elsewhere, path.join(root, "top", "mid"));
            try {
                expect(() => removeContained(path.join(root, "top"), path.join(root, "top", "mid", "keep.txt"))).toThrow(/is a link/);
            } finally {
                unlinkMid();
            }
        } finally {
            unlinkRoot();
        }
        expect(fs.existsSync(keep)).toBe(true);
    });

    it("refuses a link that no longer leads anywhere", () => {
        const gone = path.join(root, "gone");
        fs.mkdirSync(gone);
        const unlink = link(gone, path.join(root, "inside", "dangling"));
        fs.rmdirSync(gone);
        try {
            expect(() => removeContained(path.join(root, "inside"), path.join(root, "inside", "dangling"))).toThrow(/is a link/);
        } finally {
            unlink();
        }
    });

    it("refuses a target whose real path is outside the root", () => {
        // A case where the path looks contained but a real-path check says otherwise cannot be built without a link on
        // the way, which the checks above already refuse; the real-path check is the backstop for one that slips by.
        const realpath = vi.spyOn(fs, "realpathSync").mockImplementation(((value: any) => (String(value).endsWith("target") ? path.join(os.tmpdir(), "elsewhere-real") : String(value))) as any);
        try {
            write(path.join(root, "inside", "target", "f.txt"));
            expect(() => removeContained(path.join(root, "inside"), path.join(root, "inside", "target"))).toThrow(/resolves outside/);
            expect(fs.existsSync(path.join(root, "inside", "target", "f.txt"))).toBe(true);
        } finally {
            realpath.mockRestore();
        }
    });
});

describe("removeContainedAsync", () => {
    it("deletes a folder inside the root, and says when there was nothing there", async () => {
        write(path.join(root, "pkg", "deep", "file.txt"));
        expect(await removeContainedAsync(root, path.join(root, "pkg"))).toBe(true);
        expect(fs.existsSync(path.join(root, "pkg"))).toBe(false);
        expect(await removeContainedAsync(root, path.join(root, "pkg"))).toBe(false);
    });

    it("refuses the root itself and anything outside it", async () => {
        const outside = write(path.join(os.tmpdir(), `outside-async-${Date.now()}.txt`));
        try {
            await expect(removeContainedAsync(root, root)).rejects.toThrow(/isn't inside/);
            await expect(removeContainedAsync(root, outside)).rejects.toThrow(/isn't inside/);
            await expect(removeContainedAsync(root, path.join(root, "..", "elsewhere"))).rejects.toThrow(/isn't inside/);
            expect(fs.existsSync(outside)).toBe(true);
        } finally {
            fs.rmSync(outside, { force: true });
        }
    });

    it("refuses a target that is a link, leaving both the link and what it points at", async () => {
        const elsewhere = path.join(root, "elsewhere");
        const keep = write(path.join(elsewhere, "keep.txt"));
        const unlink = link(elsewhere, path.join(root, "inside", "pkg"));
        try {
            await expect(removeContainedAsync(path.join(root, "inside"), path.join(root, "inside", "pkg"))).rejects.toThrow(/is a link/);
            expect(fs.existsSync(keep)).toBe(true);
        } finally {
            unlink();
        }
    });

    it("refuses a target that contains a link, or that sits behind one", async () => {
        const elsewhere = path.join(root, "elsewhere");
        const keep = write(path.join(elsewhere, "keep.txt"));
        write(path.join(root, "inside", "pkg", "a.txt"));
        const unlinkInner = link(elsewhere, path.join(root, "inside", "pkg", "inner"));
        try {
            await expect(removeContainedAsync(path.join(root, "inside"), path.join(root, "inside", "pkg"))).rejects.toThrow(/is a link/);
            expect(fs.existsSync(path.join(root, "inside", "pkg", "a.txt"))).toBe(true);
        } finally {
            unlinkInner();
        }
        const unlinkRoot = link(elsewhere, path.join(root, "linked-root"));
        try {
            await expect(removeContainedAsync(path.join(root, "linked-root"), path.join(root, "linked-root", "keep.txt"))).rejects.toThrow(/is a link/);
        } finally {
            unlinkRoot();
        }
        expect(fs.existsSync(keep)).toBe(true);
    });

    it("refuses a link that no longer leads anywhere", async () => {
        const gone = path.join(root, "gone");
        fs.mkdirSync(gone);
        const unlink = link(gone, path.join(root, "inside", "dangling"));
        fs.rmdirSync(gone);
        try {
            await expect(removeContainedAsync(path.join(root, "inside"), path.join(root, "inside", "dangling"))).rejects.toThrow(/is a link/);
        } finally {
            unlink();
        }
    });

    it("refuses a target whose real path is outside the root", async () => {
        const realpath = vi.spyOn(fs.promises, "realpath").mockImplementation(((value: any) => Promise.resolve(String(value).endsWith("target") ? path.join(os.tmpdir(), "elsewhere-real") : String(value))) as any);
        try {
            write(path.join(root, "inside", "target", "f.txt"));
            await expect(removeContainedAsync(path.join(root, "inside"), path.join(root, "inside", "target"))).rejects.toThrow(/resolves outside/);
            expect(fs.existsSync(path.join(root, "inside", "target", "f.txt"))).toBe(true);
        } finally {
            realpath.mockRestore();
        }
    });

    it("walks a large tree without blocking (a stand-in for a plugin's full node_modules), and still deletes it all", async () => {
        for (let i = 0; i < 50; i++) {
            write(path.join(root, "pkg", `dep-${i}`, "nested", "file.js"), `// ${i}`);
        }
        expect(await removeContainedAsync(root, path.join(root, "pkg"))).toBe(true);
        expect(fs.existsSync(path.join(root, "pkg"))).toBe(false);
    });
});

describe("deletePluginFiles", () => {
    const NAME = "@rapidmx/notes-plugin";
    const manifest = (...srcs: string[]) => JSON.stringify(Object.fromEntries(srcs.map((src) => [src, { src, file: "assets/x.js" }])));

    it("deletes the installed package and every cached UI build that contains the plugin's pages, and nothing else", async () => {
        const pkg = write(path.join(root, "node_modules", "@rapidmx", "notes-plugin", "package.json"));
        const other = write(path.join(root, "node_modules", "@rapidmx", "other-plugin", "package.json"));
        const withPlugin = path.join(root, ".ui-build", "a".repeat(64));
        const withPluginToo = path.join(root, ".ui-build", "b".repeat(64));
        const without = path.join(root, ".ui-build", "c".repeat(64));
        const inUse = path.join(root, ".ui-build", "d".repeat(64));
        write(path.join(withPlugin, ".vite", "manifest.json"), manifest("plugins/node_modules/@rapidmx/notes-plugin/apps/n/index.tsx"));
        // A Windows build's manifest has escaped backslashes.
        write(path.join(withPluginToo, ".vite", "manifest.json"), JSON.stringify({ "plugins\\node_modules\\@rapidmx\\notes-plugin\\apps\\n\\index.tsx": {} }));
        write(path.join(without, ".vite", "manifest.json"), manifest("plugins/node_modules/@rapidmx/other-plugin/apps/o/index.tsx", "apps/www/index.tsx"));
        write(path.join(inUse, ".vite", "manifest.json"), manifest("plugins/node_modules/@rapidmx/notes-plugin/apps/n/index.tsx"));
        write(path.join(root, ".ui-build", ".vite-cache", "junk.txt"));
        write(path.join(root, ".ui-build", "failed-x.json"), "{}");
        const noManifest = write(path.join(root, ".ui-build", "e".repeat(64), "readme.txt"));

        const result = await deletePluginFiles(root, NAME, inUse);

        expect(result.removed.sort()).toEqual([path.join(root, "node_modules", "@rapidmx", "notes-plugin"), withPlugin, withPluginToo].sort());
        expect(fs.existsSync(path.dirname(pkg))).toBe(false);
        expect(fs.existsSync(other)).toBe(true);
        expect(fs.existsSync(withPlugin)).toBe(false);
        expect(fs.existsSync(withPluginToo)).toBe(false);
        expect(fs.existsSync(without)).toBe(true);
        expect(fs.existsSync(inUse)).toBe(true);
        expect(fs.existsSync(path.join(root, ".ui-build", ".vite-cache", "junk.txt"))).toBe(true);
        expect(fs.existsSync(noManifest)).toBe(true);
    });

    it("has nothing to do when the server never had the plugin's files", async () => {
        expect(await deletePluginFiles(root, NAME)).toEqual({ removed: [] });
        fs.mkdirSync(path.join(root, ".ui-build"));
        expect(await deletePluginFiles(root, NAME)).toEqual({ removed: [] });
    });

    it("refuses a package folder that is a link, and leaves what it points at alone", async () => {
        const elsewhere = path.join(root, "elsewhere");
        const keep = write(path.join(elsewhere, "keep.txt"));
        const unlink = link(elsewhere, path.join(root, "node_modules", "@rapidmx", "notes-plugin"));
        try {
            await expect(deletePluginFiles(root, NAME)).rejects.toThrow(/is a link/);
        } finally {
            unlink();
        }
        expect(fs.existsSync(keep)).toBe(true);
    });

    it("refuses a name that would leave the plugin directory", async () => {
        write(path.join(root, "keep.txt"));
        await expect(deletePluginFiles(root, "../../keep.txt")).rejects.toThrow();
        await expect(deletePluginFiles(root, "..")).rejects.toThrow();
        expect(fs.existsSync(path.join(root, "keep.txt"))).toBe(true);
    });
});
