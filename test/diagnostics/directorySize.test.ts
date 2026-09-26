///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
import { link, mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const failing = vi.hoisted(() => ({ readdir: "", lstat: "" }));

// Lets a test make one path unreadable, which it cannot do the same way on every platform.
vi.mock("node:fs/promises", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:fs/promises")>();
    return {
        ...actual,
        readdir: (dir: any, ...rest: any[]) =>
            failing.readdir && String(dir).endsWith(failing.readdir) ? Promise.reject(new Error("EACCES")) : (actual.readdir)(dir, ...rest),
        lstat: (file: any, ...rest: any[]) =>
            failing.lstat && String(file).endsWith(failing.lstat) ? Promise.reject(new Error("ENOENT")) : (actual.lstat)(file, ...rest),
    };
});

import { DirectorySizer, measureDirectory } from "../../src/diagnostics/directorySize.js";

describe("measureDirectory", () => {
    let root: string;

    beforeEach(async () => {
        root = await mkdtemp(path.join(os.tmpdir(), "dirsize-"));
    });

    afterEach(async () => {
        failing.readdir = "";
        failing.lstat = "";
        await rm(root, { recursive: true, force: true });
    });

    /** What `stat` says a file takes on disk, the way the walk counts it. */
    async function allocated(file: string): Promise<number> {
        const s = await stat(file);
        return s.blocks ? s.blocks * 512 : s.size;
    }

    it("adds up the space of every file and directory under it", async () => {
        await mkdir(path.join(root, "a", "b"), { recursive: true });
        await writeFile(path.join(root, "one"), Buffer.alloc(10_000, 1));
        await writeFile(path.join(root, "a", "two"), Buffer.alloc(20_000, 1));
        await writeFile(path.join(root, "a", "b", "three"), "x");

        const result = await measureDirectory(root);
        const expected =
            (await allocated(root)) +
            (await allocated(path.join(root, "a"))) +
            (await allocated(path.join(root, "a", "b"))) +
            (await allocated(path.join(root, "one"))) +
            (await allocated(path.join(root, "a", "two"))) +
            (await allocated(path.join(root, "a", "b", "three")));
        expect(result).toEqual({ bytes: expected, partial: false });
        expect(result!.bytes).toBeGreaterThanOrEqual(31_000);
    });

    it("counts a hard-linked file once and does not follow a symbolic link", async () => {
        await writeFile(path.join(root, "file"), Buffer.alloc(50_000, 1));
        const single = (await measureDirectory(root))!.bytes;

        await link(path.join(root, "file"), path.join(root, "hard"));
        expect((await measureDirectory(root))!.bytes).toBe(single);

        const outside = await mkdtemp(path.join(os.tmpdir(), "dirsize-out-"));
        try {
            await writeFile(path.join(outside, "big"), Buffer.alloc(1_000_000, 1));
            const before = (await measureDirectory(root))!.bytes;
            await symlink(outside, path.join(root, "link"), "junction");
            // The link itself takes a little space; what it points at takes none of it.
            expect((await measureDirectory(root))!.bytes - before).toBeLessThan(100_000);
        } finally {
            await rm(outside, { recursive: true, force: true });
        }
    });

    it("answers nothing for a directory that does not exist", async () => {
        expect(await measureDirectory(path.join(root, "missing"))).toBeUndefined();
    });

    it("stops at the entry limit and says the figure is a lower bound", async () => {
        for (let i = 0; i < 5; i++) {
            await writeFile(path.join(root, `f${i}`), "x");
        }
        const result = await measureDirectory(root, { maxEntries: 3, budgetMs: 10_000 });
        expect(result!.partial).toBe(true);
        expect(result!.bytes).toBeGreaterThan(0);
    });

    it("stops when it runs out of time", async () => {
        await writeFile(path.join(root, "f"), "x");
        let clock = 0;
        const result = await measureDirectory(root, { maxEntries: 1000, budgetMs: 5 }, () => (clock += 10));
        expect(result!.partial).toBe(true);
    });

    it("marks the figure partial when a directory cannot be listed", async () => {
        await mkdir(path.join(root, "gone"));
        await writeFile(path.join(root, "kept"), "x");
        failing.readdir = "gone";
        const result = await measureDirectory(root);
        expect(result!.partial).toBe(true);
        expect(result!.bytes).toBeGreaterThan(0);
    });

    it("marks the figure partial when an entry disappears while it is being read", async () => {
        await writeFile(path.join(root, "vanishing"), "x");
        failing.lstat = "vanishing";
        expect((await measureDirectory(root))!.partial).toBe(true);
    });
});

describe("DirectorySizer", () => {
    const size = (bytes: number) => ({ bytes, partial: false });

    it("waits for the first measurement of a directory and then reuses it within the time to live", async () => {
        let clock = 0;
        const measure = vi.fn(async () => size(1));
        const sizer = new DirectorySizer(measure, 1000, () => clock);
        expect(await sizer.size("/a")).toEqual(size(1));
        clock = 999;
        expect(await sizer.size("/a")).toEqual(size(1));
        expect(measure).toHaveBeenCalledTimes(1);
        await sizer.size("/b");
        expect(measure).toHaveBeenCalledTimes(2);
    });

    it("answers the old figure at once while a new one is measured, one walk at a time", async () => {
        let clock = 0;
        let release!: (value: ReturnType<typeof size>) => void;
        const measure = vi
            .fn()
            .mockResolvedValueOnce(size(1))
            .mockImplementationOnce(() => new Promise((resolve) => (release = resolve)))
            .mockResolvedValue(size(3));
        const sizer = new DirectorySizer(measure, 1000, () => clock);
        await sizer.size("/a");

        clock = 1000;
        expect(await sizer.size("/a")).toEqual(size(1));
        expect(await sizer.size("/a")).toEqual(size(1));
        expect(measure).toHaveBeenCalledTimes(2);

        release(size(2));
        await new Promise((resolve) => setImmediate(resolve));
        expect(await sizer.size("/a")).toEqual(size(2));

        // The refresh restarted the clock: the next one is due a time to live later.
        clock = 1500;
        await sizer.size("/a");
        expect(measure).toHaveBeenCalledTimes(2);
        clock = 2000;
        await sizer.size("/a");
        expect(measure).toHaveBeenCalledTimes(3);
    });

    it("keeps the old figure when a refresh fails, and tries again later", async () => {
        let clock = 0;
        const measure = vi.fn().mockResolvedValueOnce(size(1)).mockRejectedValueOnce(new Error("boom")).mockResolvedValue(size(4));
        const sizer = new DirectorySizer(measure, 1000, () => clock);
        await sizer.size("/a");
        clock = 1000;
        expect(await sizer.size("/a")).toEqual(size(1));
        await new Promise((resolve) => setImmediate(resolve));
        expect(await sizer.size("/a")).toEqual(size(1));
        expect(measure).toHaveBeenCalledTimes(3);
        await new Promise((resolve) => setImmediate(resolve));
        expect(await sizer.size("/a")).toEqual(size(4));
    });

    it("answers nothing when the first measurement fails", async () => {
        const sizer = new DirectorySizer(async () => {
            throw new Error("boom");
        });
        expect(await sizer.size("/a")).toBeUndefined();
    });

    it("measures the real file system by default", async () => {
        const dir = await mkdtemp(path.join(os.tmpdir(), "dirsize-default-"));
        try {
            expect((await new DirectorySizer().size(dir))?.partial).toBe(false);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});
