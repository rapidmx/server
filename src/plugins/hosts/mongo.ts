///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { AdminConsoleRoute } from "../../mongo/routes/AdminConsoleRoute.js";
import { EscrowConsoleRoute } from "../../mongo/routes/EscrowConsoleRoute.js";
import { PublicPageRoute } from "../../mongo/routes/PublicPageRoute.js";
import { WwwRoute } from "../../mongo/routes/wwwRoute.js";
import type { PluginUiHostClasses } from "../PluginUiRoutes.js";

/** The base routes plugin UI apps extend on MongoDB. */
export const MONGO_PLUGIN_UI_HOSTS: PluginUiHostClasses = {
    www: WwwRoute,
    admin: AdminConsoleRoute,
    escrow: EscrowConsoleRoute,
    public: PublicPageRoute,
};
