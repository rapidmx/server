///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
import { ObjectDecorators, UserUtils } from "@rapidrest/core";
import { ReactRoute } from "@rapidrest/react";
import { ObjectFactory, RouteDecorators, type HttpRequest } from "@rapidrest/service-core";
import { fetchAppearanceForSSR, fetchBrandingPropsForSSR } from "@rapidmx/restapi";
import { AppearancePreferencesSQL, BrandingSQL } from "@rapidmx/restapi/sql";
import { isRunningUnderYarnDev } from "../../dev/enableDevAutoLogin.js";
import { getPluginNav } from "../../plugins/pluginNav.js";
import { webClientAppDir } from "../../routes/webClientAppDir.js";

const { Route } = RouteDecorators;
const { Config, Inject, Logger } = ObjectDecorators;

@Route("/")
export class AppRoute extends ReactRoute {
    protected readonly appDir: string = webClientAppDir("www");
    protected readonly hydrate: boolean = true;

    @Config("mail:auth_server_url")
    private authServerUrl?: string;

    @Config("trusted_roles", ["admin"])
    private trustedRoles: string[] = ["admin"];

    @Inject(ObjectFactory)
    private brandingObjectFactory!: ObjectFactory;

    @Logger
    private appearanceLogger?: any;

    protected async fetchProps(req: HttpRequest): Promise<any> {
        // Presence alone is enough — the cookie's own validity is what actually governs the active session;
        // this only drives whether the client shows a "stop impersonating" affordance (see MailShell.tsx).
        // Empty string under `yarn dev` tells the client to call this app's own local dev-only impersonation
        // endpoint (see `DevImpersonationRoute`) instead of a real auth-server that isn't running locally.
        const impersonationBaseUrl = isRunningUnderYarnDev() ? "" : (this.authServerUrl ?? "");
        // Feeds this deployment's branding (title/favicon/icon/logo/stylesheet) into `apps/www/_layout.tsx`
        // - `@rapidrest/react` spreads the same merged page props onto the layout as onto the page it wraps,
        // so it renders correctly server-side on the very first byte of the response: no client-side flash
        // from the stock defaults, and a crawler reading the raw HTML sees the real branding too.
        const { branding } = await fetchBrandingPropsForSSR(this.brandingObjectFactory, BrandingSQL);
        // The signed-in user's saved appearance (theme mode, colours, background), so the theme is applied in the first byte of
        // HTML instead of flashing the default. One read of one row that can never fail the page (undefined when there is none).
        const appearance = await fetchAppearanceForSSR(this.brandingObjectFactory, AppearancePreferencesSQL, req.user?.uid, this.appearanceLogger);
        return {
            authServerUrl: this.authServerUrl,
            impersonationBaseUrl,
            impersonating: !!req.cookies?.["jwt_impersonator"],
            // Drives the user menu's "Admin" item (see UserMenu.tsx) — a trusted-role caller can always reach
            // the admin console, this just saves them from navigating there manually to discover that.
            trusted: UserUtils.hasRoles(req.user, this.trustedRoles),
            // The role names that count as trusted (`trusted_roles`), so the user menu can ask auth-server whether the
            // caller holds one without hard-coding "admin". `trusted` above is false for an administrator whose token
            // isn't elevated (auth-server strips trusted roles from it); the link this drives only navigates.
            trustedRoles: this.trustedRoles,
            branding,
            appearance,
            // Settings sections and app rail entries from loaded plugins whose UI built (see plugins/pluginNav.ts).
            pluginNav: getPluginNav(),
        };
    }
}
