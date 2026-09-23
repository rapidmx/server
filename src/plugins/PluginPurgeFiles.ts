///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import fs from "fs";
import path from "path";
import { UI_BUILD_DIR } from "./PluginUiBuilder.js";

/** Whether `child` is `root` or below it, comparing resolved paths (case-insensitively on Windows). */
export function isContained(root: string, child: string): boolean {
    const normalize = (value: string): string => (process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value));
    const relative: string = path.relative(normalize(root), normalize(child));
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** The first symbolic link or junction at or below `dir`, found without following any link. */
function findLink(dir: string): string | undefined {
    const stat: fs.Stats = fs.lstatSync(dir);
    if (stat.isSymbolicLink()) {
        return dir;
    }
    if (!stat.isDirectory()) {
        return undefined;
    }
    for (const entry of fs.readdirSync(dir)) {
        const found: string | undefined = findLink(path.join(dir, entry));
        if (found) {
            return found;
        }
    }
    return undefined;
}

/**
 * Deletes `target` (a file or folder) if it lies inside `root`, and only then: never through a link. The target must not
 * be a symbolic link or junction, nor contain one, and its real path must be where it appears to be - so a link that
 * leads out of the plugin directories can never make this delete what isn't the server's own.
 *
 * @returns `true` when something was deleted, `false` when it didn't exist.
 * @throws when `target` is outside `root`, is or holds a link, or can't be removed.
 */
export function removeContained(root: string, target: string): boolean {
    const resolvedRoot: string = path.resolve(root);
    const resolvedTarget: string = path.resolve(target);
    if (resolvedTarget === resolvedRoot || !isContained(resolvedRoot, resolvedTarget)) {
        throw new Error(`Refusing to delete ${resolvedTarget}: it isn't inside ${resolvedRoot}.`);
    }
    if (!fs.existsSync(resolvedTarget) && !isLink(resolvedTarget)) {
        return false;
    }
    // No link on the way down from the root either: `root` itself, or a folder between it and the target.
    let step: string = resolvedRoot;
    for (const part of [".", ...path.relative(resolvedRoot, resolvedTarget).split(path.sep)]) {
        step = part === "." ? step : path.join(step, part);
        if (isLink(step)) {
            throw new Error(`Refusing to delete ${resolvedTarget}: ${step} is a link.`);
        }
    }
    const link: string | undefined = findLink(resolvedTarget);
    if (link) {
        throw new Error(`Refusing to delete ${resolvedTarget}: ${link} is a link.`);
    }
    if (fs.existsSync(resolvedRoot) && !isContained(fs.realpathSync(resolvedRoot), fs.realpathSync(resolvedTarget))) {
        throw new Error(`Refusing to delete ${resolvedTarget}: it resolves outside ${resolvedRoot}.`);
    }
    fs.rmSync(resolvedTarget, { recursive: true, force: true });
    return true;
}

function isLink(target: string): boolean {
    try {
        return fs.lstatSync(target).isSymbolicLink();
    } catch {
        return false;
    }
}

/** The first symbolic link or junction at or below `dir`, found without following any link - the async twin of
 * `findLink()`, used by `removeContainedAsync()` so the walk doesn't block the event loop. */
async function findLinkAsync(dir: string): Promise<string | undefined> {
    const stat: fs.Stats = await fs.promises.lstat(dir);
    if (stat.isSymbolicLink()) {
        return dir;
    }
    if (!stat.isDirectory()) {
        return undefined;
    }
    for (const entry of await fs.promises.readdir(dir)) {
        const found: string | undefined = await findLinkAsync(path.join(dir, entry));
        if (found) {
            return found;
        }
    }
    return undefined;
}

async function isLinkAsync(target: string): Promise<boolean> {
    try {
        return (await fs.promises.lstat(target)).isSymbolicLink();
    } catch {
        return false;
    }
}

async function existsAsync(target: string): Promise<boolean> {
    try {
        await fs.promises.stat(target);
        return true;
    } catch {
        return false;
    }
}

/**
 * The async twin of `removeContained()` - same refuse-outside-root/never-through-a-link contract, but walks the tree
 * with `fs.promises` instead of the `*Sync` calls, so deleting a large tree (a plugin's full `node_modules`, routinely
 * thousands of files) doesn't block the event loop of a process also serving live HTTP/mail traffic for the walk's
 * whole duration. `removeContained()` itself is kept for callers whose target is always small and bounded (a single
 * plugin's own scratch install directory), where the sync call's simplicity is worth keeping.
 *
 * @returns `true` when something was deleted, `false` when it didn't exist.
 * @throws when `target` is outside `root`, is or holds a link, or can't be removed.
 */
export async function removeContainedAsync(root: string, target: string): Promise<boolean> {
    const resolvedRoot: string = path.resolve(root);
    const resolvedTarget: string = path.resolve(target);
    if (resolvedTarget === resolvedRoot || !isContained(resolvedRoot, resolvedTarget)) {
        throw new Error(`Refusing to delete ${resolvedTarget}: it isn't inside ${resolvedRoot}.`);
    }
    if (!(await existsAsync(resolvedTarget)) && !(await isLinkAsync(resolvedTarget))) {
        return false;
    }
    // No link on the way down from the root either: `root` itself, or a folder between it and the target.
    let step: string = resolvedRoot;
    for (const part of [".", ...path.relative(resolvedRoot, resolvedTarget).split(path.sep)]) {
        step = part === "." ? step : path.join(step, part);
        if (await isLinkAsync(step)) {
            throw new Error(`Refusing to delete ${resolvedTarget}: ${step} is a link.`);
        }
    }
    const link: string | undefined = await findLinkAsync(resolvedTarget);
    if (link) {
        throw new Error(`Refusing to delete ${resolvedTarget}: ${link} is a link.`);
    }
    if (await existsAsync(resolvedRoot)) {
        const [realRoot, realTarget] = await Promise.all([fs.promises.realpath(resolvedRoot), fs.promises.realpath(resolvedTarget)]);
        if (!isContained(realRoot, realTarget)) {
            throw new Error(`Refusing to delete ${resolvedTarget}: it resolves outside ${resolvedRoot}.`);
        }
    }
    await fs.promises.rm(resolvedTarget, { recursive: true, force: true });
    return true;
}

/** What `deletePluginFiles()` removed, for the step's note. */
export interface PluginFilesResult {
    removed: string[];
}

/**
 * Deletes what this server copy still has on disk for a removed plugin: its installed package
 * (`<plugins dir>/node_modules/<name>`, normally already gone because npm prunes it at the restart that applied the
 * removal) and every cached UI build that contains its pages (`<plugins dir>/.ui-build/<hash>`, judged by the build's
 * Vite manifest naming the plugin's package; the build in use, `keepBuild`, is never touched). Only paths inside the
 * plugins directory are ever deleted, and never through a link.
 *
 * Async (`fs.promises` throughout, `removeContainedAsync()` for both removals) rather than the old fully-synchronous
 * walk: the package directory is a plugin's whole `node_modules` tree - routinely thousands of files - and this runs
 * on the same process serving live HTTP/mail traffic, on every purge attempt (retried every `checkIntervalMs` on
 * failure), so a synchronous walk of it stalled the event loop for the walk's entire duration.
 */
export async function deletePluginFiles(pluginsDir: string, pluginName: string, keepBuild?: string): Promise<PluginFilesResult> {
    const removed: string[] = [];
    const packageDir: string = path.join(pluginsDir, "node_modules", ...pluginName.split("/"));
    if (await removeContainedAsync(path.join(pluginsDir, "node_modules"), packageDir)) {
        removed.push(packageDir);
    }

    const buildRoot: string = path.join(pluginsDir, UI_BUILD_DIR);
    let entries: string[] = [];
    try {
        entries = await fs.promises.readdir(buildRoot);
    } catch {
        return { removed };
    }
    const needle: string = `/node_modules/${pluginName}/`;
    for (const entry of entries) {
        const build: string = path.join(buildRoot, entry);
        if (entry.startsWith(".") || (keepBuild !== undefined && path.resolve(keepBuild) === path.resolve(build))) {
            continue;
        }
        let manifest: string;
        try {
            manifest = await fs.promises.readFile(path.join(build, ".vite", "manifest.json"), "utf8");
        } catch {
            continue;
        }
        if (manifest.replace(/\\\\/g, "/").includes(needle) && (await removeContainedAsync(buildRoot, build))) {
            removed.push(build);
        }
    }
    return { removed };
}
