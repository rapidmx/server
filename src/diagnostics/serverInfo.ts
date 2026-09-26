///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
import { readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DiagnosticsPackage, DiagnosticsServerInfo } from "./types.js";

export interface PackageJson {
    name?: string;
    version?: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
}

/** How many package.json files are read at once, so a big `node_modules` does not exhaust file descriptors. */
const READ_CONCURRENCY = 32;

export async function readPackageJson(file: string): Promise<PackageJson | undefined> {
    try {
        return JSON.parse(await readFile(file, "utf8")) as PackageJson;
    } catch {
        return undefined;
    }
}

export function collectServerInfo(pkg: PackageJson | undefined, now: Date = new Date()): DiagnosticsServerInfo {
    const uptimeSeconds = Math.round(process.uptime());
    return {
        nodeVersion: process.version,
        v8Version: process.versions.v8,
        packageName: pkg?.name ?? "",
        packageVersion: pkg?.version ?? "",
        platform: process.platform,
        arch: process.arch,
        hostname: os.hostname(),
        pid: process.pid,
        startedAt: new Date(now.getTime() - uptimeSeconds * 1000).toISOString(),
        uptimeSeconds,
        nodeEnv: process.env.NODE_ENV ?? "",
    };
}

/** The `<scope>/<name>` or `<name>` directories directly under `nodeModules`, without its bookkeeping entries. */
async function packageDirectories(nodeModules: string): Promise<string[]> {
    let entries;
    try {
        entries = await readdir(nodeModules, { withFileTypes: true });
    } catch {
        return [];
    }
    const found: string[] = [];
    for (const entry of entries) {
        if (entry.name.startsWith(".") || !(entry.isDirectory() || entry.isSymbolicLink())) {
            continue;
        }
        if (entry.name.startsWith("@")) {
            const scoped = await readdir(path.join(nodeModules, entry.name), { withFileTypes: true }).catch(() => []);
            found.push(...scoped.filter((s) => !s.name.startsWith(".")).map((s) => `${entry.name}/${s.name}`));
        } else {
            found.push(entry.name);
        }
    }
    return found;
}

/**
 * Every package installed at the top of `<root>/node_modules` with its version, sorted by name. Packages nested inside
 * another package's own `node_modules` (a second copy at a different version) are not listed.
 */
export async function collectPackages(root: string, pkg: PackageJson | undefined): Promise<DiagnosticsPackage[]> {
    const nodeModules = path.join(root, "node_modules");
    const direct = new Set([
        ...Object.keys(pkg?.dependencies ?? {}),
        ...Object.keys(pkg?.devDependencies ?? {}),
        ...Object.keys(pkg?.optionalDependencies ?? {}),
    ]);
    const directories = await packageDirectories(nodeModules);
    const packages: DiagnosticsPackage[] = [];
    let next = 0;
    const worker = async () => {
        while (next < directories.length) {
            const name = directories[next++];
            const manifest = await readPackageJson(path.join(nodeModules, name, "package.json"));
            if (manifest?.version) {
                packages.push({ name: manifest.name ?? name, version: manifest.version, direct: direct.has(manifest.name ?? name) });
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, directories.length) }, worker));
    return packages.sort((a, b) => a.name.localeCompare(b.name));
}
