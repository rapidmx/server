///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { ObjectFactory } from "@rapidrest/service-core";
import {
    inspectPack,
    isValidPackageName,
    LocalFsBlobStore,
    packIntegrity,
    PLUGIN_UPLOAD_BLOB_PREFIX,
    S3BlobStore,
    type BlobStore,
    type Plugin,
} from "@rapidmx/restapi";
import { selectConfigDrivenBackend } from "../lib/configDrivenBackend.js";
import { SHARED_PLUGIN_PEERS, type DesiredPlugin } from "./PluginInstaller.js";

/** The directory, below the plugins directory, holding the uploaded packs this copy has fetched. */
export const UPLOAD_CACHE_DIR = "uploads";

/** A blob key `pluginUploadBlobKey()` could have produced. Nothing else is ever read from the blob store on a row's say-so:
 * the plugin table is writable by anyone who can write to the database, and the blob store also holds mail. */
const UPLOAD_BLOB_KEY = new RegExp(`^${PLUGIN_UPLOAD_BLOB_PREFIX.replace(/\//g, "\\/")}([0-9a-f]{64})\\.tgz$`);

/** Dependency specs that don't come from the registry: a path on this server's disk or a URL. */
const NON_REGISTRY_SPEC = /^(file:|link:|portal:|workspace:|git[+:]|github:|gitlab:|bitbucket:|gist:|https?:|[./~])/i;

/** What uploaded plugins need from the blob store. */
export type UploadBlobStore = Pick<BlobStore, "get">;

/**
 * The server's configured blob store (`mail:blob:backend`, local or S3, with their `mail:blob:*` settings), built before
 * the server's own dependency injection exists - the uploaded packs have to be installed before any plugin class loads, which
 * is before the server starts. It is the same selection `registerCoreProviders()` makes, instantiated through its own short-lived
 * `ObjectFactory` (as `PluginStateStore` does for its connection) so the `@Config` settings, secrets included, are read by the
 * store itself exactly as they are for the server's copy. `close()` releases it.
 */
export async function openConfiguredBlobStore(config: any, logger: any): Promise<{ store: UploadBlobStore; close: () => Promise<void> }> {
    const objectFactory = new ObjectFactory(config, logger);
    objectFactory.register(selectConfigDrivenBackend(config, "mail:blob:backend", "s3", LocalFsBlobStore, S3BlobStore), "BlobStore");
    const store: UploadBlobStore = await objectFactory.newInstance<UploadBlobStore>("BlobStore");
    return { store, close: () => objectFactory.destroy() };
}

/** The error message for a pack that can't be used, with the pack's own plugin name left to the caller. */
export class UploadedPackError extends Error {}

export interface PreparedUploads {
    /** The enabled upload rows whose packs are cached and verified, as the installer takes them. */
    desired: Map<string, DesiredPlugin>;
    /** The upload rows that can't be installed, each with why. */
    errors: { name: string; message: string }[];
}

export interface PrepareUploadsOptions {
    config: any;
    logger: any;
    /** `<plugins dir>`; packs are cached at `<plugins dir>/uploads/<sha256>.tgz`. */
    pluginsDir: string;
    /** Package names the operator installs from `system:plugins:sources`, which take the place of an upload. */
    configuredSources?: Set<string>;
    /** Replaces the configured blob store (tests). */
    blobStore?: UploadBlobStore;
}

/**
 * Makes the packs behind the enabled upload rows ready to install: reads each from the local cache, or from the shared blob
 * store at the row's own `uploadBlobKey` when this copy doesn't have it yet, checks it (the SHA-512 recorded when it was
 * uploaded, `inspectPack()` again, and that its `package.json` is the plugin the row says) and writes it into the cache. A pack
 * that fails any step is reported in `errors` and skipped; the others are unaffected. Cached packs no row refers to are
 * removed. `known` is whether `rows` is the whole plugin table - without it nothing is removed from the cache.
 *
 * The cache lives in the plugin directory, which is per pod: copies never share it, and each file is written to a temporary
 * name and renamed into place (a file's name is the hash of its content), so a second process doing the same can't leave a
 * partial file behind.
 */
export async function prepareUploadedPlugins(rows: Plugin[], options: PrepareUploadsOptions, known: boolean = true): Promise<PreparedUploads> {
    const { config, logger, pluginsDir } = options;
    const desired: Map<string, DesiredPlugin> = new Map();
    const errors: { name: string; message: string }[] = [];
    const cacheDir: string = path.join(pluginsDir, UPLOAD_CACHE_DIR);
    const wanted: Set<string> = new Set();
    const enabled: boolean = config.get("system:plugins:uploads:enabled") ?? true;
    let opened: { store: UploadBlobStore; close: () => Promise<void> } | undefined;
    try {
        for (const row of rows) {
            if (!enabled) {
                const message: string = "Uploaded plugins are turned off (system:plugins:uploads:enabled), so it wasn't installed.";
                logger.error(`Plugin ${row.name} was not loaded: ${message}`);
                errors.push({ name: row.name, message });
                continue;
            }
            try {
                const hex: string = UploadedPack.hashOf(row);
                wanted.add(hex);
                if (options.configuredSources?.has(row.name)) {
                    throw new UploadedPackError("The same package is set in system:plugins:sources, which takes its place.");
                }
                const file: string = path.join(cacheDir, `${hex}.tgz`);
                const bytes: Buffer = await UploadedPack.read(row, hex, file, async () => {
                    opened ??= options.blobStore ? { store: options.blobStore, close: async () => undefined } : await openConfiguredBlobStore(config, logger);
                    return opened.store;
                });
                await UploadedPack.verify(row, bytes);
                UploadedPack.cache(file, bytes);
                desired.set(row.name, { name: row.name, packageVersion: row.packageVersion, integrity: row.integrity, pack: file });
            } catch (err: any) {
                const message: string = err instanceof UploadedPackError ? err.message : `The uploaded pack couldn't be fetched: ${err.message}`;
                logger.error(`Plugin ${row.name} was not loaded: ${message}`);
                errors.push({ name: row.name, message });
            }
        }
    } finally {
        await opened?.close().catch(() => undefined);
    }
    if (known) {
        UploadedPack.prune(cacheDir, wanted, logger);
    }
    return { desired, errors };
}

/** One uploaded pack's steps. */
const UploadedPack = {
    /** The SHA-256 (hex) the row's blob key names. */
    hashOf(row: Plugin): string {
        const match: RegExpExecArray | null = UPLOAD_BLOB_KEY.exec(String(row.uploadBlobKey ?? ""));
        if (!match) {
            throw new UploadedPackError("The plugin's uploaded pack isn't recorded (no valid blob key), so it can't be installed. Upload it again.");
        }
        if (!isValidPackageName(row.name) || SHARED_PLUGIN_PEERS.includes(row.name)) {
            throw new UploadedPackError(`${row.name} can't be installed from an upload: it is a package the server shares with its plugins.`);
        }
        if (!row.integrity) {
            throw new UploadedPackError("No integrity hash was recorded when the pack was uploaded, so it can't be verified. Upload it again.");
        }
        return match[1];
    },

    /** The pack's bytes: this copy's cached file when it holds exactly the recorded pack, else the blob store's. Throws
     * when the blob is missing or isn't the pack that was recorded. */
    async read(row: Plugin, hex: string, file: string, blobStore: () => Promise<UploadBlobStore>): Promise<Buffer> {
        try {
            const cached: Buffer = fs.readFileSync(file);
            if (packIntegrity(cached) === row.integrity) {
                return cached;
            }
        } catch {
            // Not cached yet.
        }
        let bytes: Buffer;
        try {
            bytes = await (await blobStore()).get(row.uploadBlobKey!);
        } catch (err: any) {
            throw new UploadedPackError(`The uploaded pack (${row.uploadFilename ?? row.uploadBlobKey}) couldn't be read from the blob store: ${err.message}`);
        }
        if (crypto.createHash("sha256").update(bytes).digest("hex") !== hex || packIntegrity(bytes) !== row.integrity) {
            throw new UploadedPackError("The uploaded pack in the blob store isn't the one that was recorded (its hash doesn't match), so it wasn't installed.");
        }
        return bytes;
    },

    /** Re-checks `bytes` the way the upload route did, and that the package is the plugin and version `row` names. */
    async verify(row: Plugin, bytes: Buffer): Promise<void> {
        let pkg: Record<string, any>;
        try {
            pkg = (await inspectPack(bytes)).packageJson;
        } catch (err: any) {
            throw new UploadedPackError(`The uploaded pack isn't a valid plugin package: ${err.message}`);
        }
        if (pkg.name !== row.name) {
            throw new UploadedPackError(`The uploaded pack is for ${String(pkg.name)}, not ${row.name}.`);
        }
        if (pkg.version !== row.packageVersion) {
            throw new UploadedPackError(`The uploaded pack is version ${String(pkg.version)}, not ${row.packageVersion}.`);
        }
        // The pack's own dependencies come from the registry; one that points at a path or URL would reach outside it.
        for (const field of ["dependencies", "optionalDependencies"]) {
            for (const [name, spec] of Object.entries(pkg[field] ?? {})) {
                if (typeof spec !== "string" || NON_REGISTRY_SPEC.test(spec.trim())) {
                    throw new UploadedPackError(`The uploaded pack depends on ${name} from "${String(spec)}", which isn't a registry version.`);
                }
            }
        }
    },

    /** Writes `bytes` to `file` (mode 0600) unless it is already there, through a temporary file renamed into place. */
    cache(file: string, bytes: Buffer): void {
        try {
            if (fs.statSync(file).size === bytes.length && fs.readFileSync(file).equals(bytes)) {
                return;
            }
        } catch {
            // Not cached yet, or unreadable: written below.
        }
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        const temp: string = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
        try {
            fs.writeFileSync(temp, bytes, { mode: 0o600 });
            fs.renameSync(temp, file);
        } finally {
            fs.rmSync(temp, { force: true });
        }
    },

    /** Removes cached packs (and temporary files left by a stopped write) that no row refers to. */
    prune(cacheDir: string, wanted: Set<string>, logger: any): void {
        let names: string[];
        try {
            names = fs.readdirSync(cacheDir);
        } catch {
            return;
        }
        for (const name of names) {
            const match: RegExpExecArray | null = /^([0-9a-f]{64})\.tgz(\.tmp-.*)?$/.exec(name);
            if (match && !match[2] && wanted.has(match[1])) {
                continue;
            }
            try {
                // A temporary file may be another process's write in progress; only one a stopped write left behind goes.
                if (match?.[2] && Date.now() - fs.statSync(path.join(cacheDir, name)).mtimeMs < 10 * 60_000) {
                    continue;
                }
                fs.rmSync(path.join(cacheDir, name), { recursive: true, force: true });
            } catch (err: any) {
                logger.debug?.(`Could not remove the cached upload ${name}: ${err.message}`);
            }
        }
    },
};
