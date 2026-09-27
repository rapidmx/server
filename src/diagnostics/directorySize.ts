///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";

/** What a directory holds, as `du` counts it: the space its files and directories take on disk. */
export interface DirectorySize {
    bytes: number;
    /** The walk stopped early (too many entries, out of time) or could not read something, so `bytes` is a lower bound. */
    partial: boolean;
}

/** Measures one directory. `undefined` when it cannot be read at all. */
export type SizeDirectory = (dir: string) => Promise<DirectorySize | undefined>;

export interface DirectoryWalkLimits {
    /** Entries visited before the walk gives up and reports what it has. */
    maxEntries: number;
    /** Time the walk may take before it gives up and reports what it has. */
    budgetMs: number;
}

export const DEFAULT_WALK_LIMITS: DirectoryWalkLimits = { maxEntries: 200_000, budgetMs: 2_000 };

/** The disk space a file takes: whole blocks, as `du` counts them, else its length where the platform reports no blocks. */
export function allocatedBytes(stats: { blocks?: number; size: number }): number {
    return stats.blocks ? stats.blocks * 512 : stats.size;
}

/**
 * The size of everything under `dir`, counted like `du -s` (allocated blocks, a hard-linked file once, symbolic links as links
 * and not followed). This is what a volume that shares the node's disk holds: asking the filesystem for its usage would answer
 * for the whole disk. The walk is bounded (`limits`) so a huge tree cannot hold a request up: it then reports `partial`.
 */
export async function measureDirectory(
    dir: string,
    limits: DirectoryWalkLimits = DEFAULT_WALK_LIMITS,
    now: () => number = Date.now
): Promise<DirectorySize | undefined> {
    let root;
    try {
        root = await lstat(dir);
    } catch {
        return undefined;
    }
    const deadline = now() + limits.budgetMs;
    const seen = new Set<string>();
    let bytes = allocatedBytes(root);
    let visited = 0;
    let partial = false;
    const pending = [dir];

    const count = (stats: { blocks?: number; size: number; nlink: number; dev: number; ino: number }) => {
        if (stats.nlink > 1) {
            const id = `${stats.dev}:${stats.ino}`;
            if (seen.has(id)) {
                return;
            }
            seen.add(id);
        }
        bytes += allocatedBytes(stats);
    };

    while (pending.length > 0) {
        const current = pending.pop() as string;
        let entries;
        try {
            entries = await readdir(current, { withFileTypes: true });
        } catch {
            partial = true;
            continue;
        }
        for (const entry of entries) {
            if (visited >= limits.maxEntries || now() > deadline) {
                return { bytes, partial: true };
            }
            visited++;
            const full = path.join(current, entry.name);
            try {
                const stats = await lstat(full);
                count(stats);
                if (stats.isDirectory()) {
                    pending.push(full);
                }
            } catch {
                // Gone since it was listed, or unreadable: the figure is then a lower bound.
                partial = true;
            }
        }
    }
    return { bytes, partial };
}

/** How long a measurement is reused before another is started. */
export const DIRECTORY_SIZE_TTL_MS = 30_000;

/**
 * Measures directories for the page's polling: a walk is more work than a `statfs`, and the page asks every few seconds. A
 * measurement is reused for `ttlMs`; after that the old figure is still answered at once while a new walk runs (only one at a time
 * for a directory), so a slow walk never holds a sample up. Only the very first sample of a directory waits for its walk.
 */
export class DirectorySizer {
    private readonly cache = new Map<string, { at: number; value: DirectorySize | undefined; refreshing?: Promise<void> }>();

    constructor(
        private readonly measure: SizeDirectory = measureDirectory,
        private readonly ttlMs: number = DIRECTORY_SIZE_TTL_MS,
        private readonly now: () => number = Date.now
    ) {}

    async size(dir: string): Promise<DirectorySize | undefined> {
        const entry = this.cache.get(dir);
        if (!entry) {
            const value = await this.measure(dir).catch(() => undefined);
            this.cache.set(dir, { at: this.now(), value });
            return value;
        }
        if (this.now() - entry.at >= this.ttlMs && !entry.refreshing) {
            entry.refreshing = this.measure(dir).then(
                (value) => {
                    entry.value = value;
                    entry.at = this.now();
                    entry.refreshing = undefined;
                },
                () => {
                    entry.refreshing = undefined;
                }
            );
        }
        return entry.value;
    }
}
