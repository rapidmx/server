///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { AuditLogEntrySQL } from "@rapidmx/restapi/sql";
import { PluginPurgeSQL } from "../../sql/PluginPurgeSQL.js";
import { AdminConsoleRoute } from "../../sql/routes/AdminConsoleRoute.js";
import { EscrowConsoleRoute } from "../../sql/routes/EscrowConsoleRoute.js";
import { PublicPageRoute } from "../../sql/routes/PublicPageRoute.js";
import { AppRoute } from "../../sql/routes/wwwRoute.js";
import type { PluginUiHostClasses } from "../PluginUiRoutes.js";

/** The base routes plugin UI apps extend on SQL databases. */
export const SQL_PLUGIN_UI_HOSTS: PluginUiHostClasses = {
    www: AppRoute,
    admin: AdminConsoleRoute,
    escrow: EscrowConsoleRoute,
    public: PublicPageRoute,
};

/** What deleting an uninstalled plugin's data uses on SQL databases (see `PluginHostOptions.purge`). */
export const SQL_PLUGIN_PURGE = { purgeClass: PluginPurgeSQL, auditLogClass: AuditLogEntrySQL };
