///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
import { ObjectDecorators } from "@rapidrest/core";
import { ReactRoute } from "@rapidrest/react";
import { ObjectFactory, RouteDecorators, type HttpRequest } from "@rapidrest/service-core";
import { fetchBrandingPropsForSSR } from "@rapidmx/restapi";
import { BrandingMongo } from "@rapidmx/restapi/mongo";
import { isRunningUnderYarnDev } from "../../dev/enableDevAutoLogin.js";
import { getPluginNav } from "../../plugins/pluginNav.js";
import { webClientAppDir } from "../../routes/webClientAppDir.js";

const { Route } = RouteDecorators;
const { Config, Inject } = ObjectDecorators;

@Route("/admin")
export class AdminConsoleRoute extends ReactRoute {
    protected readonly appDir: string = webClientAppDir("admin");
    protected readonly hydrate: boolean = true;
    /** Client-side navigation between this app's pages (`@rapidrest/react`'s router; the client build lists this app's directory in `ROUTER_APP_DIRS`, src/lib/serverViteConfig.ts). */
    protected readonly router: boolean = true;

    @Config("mail:auth_server_url")
    private authServerUrl?: string;

    @Inject(ObjectFactory)
    private brandingObjectFactory!: ObjectFactory;

    /** See `WwwRoute.fetchProps()` (`src/mongo/routes/wwwRoute.ts`) — identical purpose, for the admin console. */
    protected async fetchProps(_req: HttpRequest): Promise<any> {
        // Empty string under `yarn dev` tells the client to call this app's own local dev-only impersonation
        // endpoint (see `DevImpersonationRoute`) instead of a real auth-server that isn't running locally.
        const impersonationBaseUrl = isRunningUnderYarnDev() ? "" : (this.authServerUrl ?? "");
        const { branding } = await fetchBrandingPropsForSSR(this.brandingObjectFactory, BrandingMongo);
        // pluginNav: navigation entries from loaded plugins whose UI built (see plugins/pluginNav.ts).
        return { authServerUrl: this.authServerUrl, impersonationBaseUrl, branding, pluginNav: getPluginNav() };
    }
}
