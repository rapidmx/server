///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import fs from "fs";
import os from "os";
import path from "path";
import { RESERVED_PLUGIN_UI_MOUNTS } from "@rapidmx/restapi";
import { webClientReservedMounts } from "../../src/plugins/reservedMounts.js";

describe("webClientReservedMounts", () => {
    it("lists the pages of the installed web client's apps, including ones restapi's own list lacks", () => {
        const mounts = webClientReservedMounts(process.cwd());
        for (const mount of ["/admin/diagnostics", "/admin/signing-certificates", "/admin/mailboxes", "/calendar", "/settings/appearance", "/escrow/matters", "/admin"]) {
            expect(mounts.has(mount), mount).toBe(true);
        }
        // Everything restapi reserves that the web client serves stays reserved, whichever list is behind.
        expect(mounts.has("/admin/_layout")).toBe(false);
        expect(mounts.has("/admin/index")).toBe(false);
        expect(RESERVED_PLUGIN_UI_MOUNTS).toContain("/admin/plugins");
        expect(mounts.has("/admin/plugins")).toBe(true);
    });

    it("reads page directories and files, skipping layouts, errors and the index", () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "reserved-"));
        try {
            const apps = path.join(root, "node_modules/@rapidmx/web-client/apps");
            fs.mkdirSync(path.join(apps, "admin/reports"), { recursive: true });
            fs.writeFileSync(path.join(apps, "admin/_layout.tsx"), "");
            fs.writeFileSync(path.join(apps, "admin/index.tsx"), "");
            fs.writeFileSync(path.join(apps, "admin/Health.tsx"), "");
            fs.mkdirSync(path.join(apps, "www/settings/Theme"), { recursive: true });
            const mounts = webClientReservedMounts(root);
            expect([...mounts].sort()).toEqual(["/admin", "/admin/health", "/admin/reports", "/escrow", "/settings", "/settings/theme"]);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it("is just the base paths when the web client isn't installed", () => {
        expect([...webClientReservedMounts(path.join(os.tmpdir(), "nowhere-" + Date.now()))].sort()).toEqual(["/admin", "/escrow"]);
    });
});
