#!/usr/bin/env node
// Writes a brotli (.br) and gzip (.gz) sibling next to every compressible file of the browser build, so the server sends
// them with Content-Encoding instead of compressing on each request (src/lib/staticAssets.ts). Runs after `rapidrest build`
// (see the "build" script), which compiles src/ to dist/src/ first. Usage: node scripts/precompress-assets.mjs [dir]
import path from "node:path";
import { fileURLToPath } from "node:url";
import { precompressDirectory } from "../dist/src/lib/staticAssets.js";

const dir = path.resolve(process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "public"));
const started = Date.now();
const result = await precompressDirectory(dir);
const kb = (bytes) => `${(bytes / 1024).toFixed(0)} KiB`;
console.log(
    `Pre-compressed ${result.compressed} files in ${dir} (${kb(result.bytesBefore)} -> ${kb(result.bytesAfter)}), ` +
        `${result.skipped} left as they are, in ${((Date.now() - started) / 1000).toFixed(1)}s.`,
);
