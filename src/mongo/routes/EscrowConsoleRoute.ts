///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
import { ObjectDecorators } from "@rapidrest/core";
import { ReactRoute } from "@rapidrest/react";
import { ObjectFactory, RouteDecorators, type HttpRequest } from "@rapidrest/service-core";
import { fetchBrandingPropsForSSR } from "@rapidmx/restapi";
import { BrandingMongo } from "@rapidmx/restapi/mongo";
import { webClientAppDir } from "../../routes/webClientAppDir.js";

const { Route } = RouteDecorators;
const { Config, Inject } = ObjectDecorators;

/**
 * Mounts `@rapidmx/web-client`'s `apps/escrow` console - the holder-facing counterpart to `apps/admin`,
 * same `ReactRoute`/`webClientAppDir()` mechanism as `AdminConsoleRoute`/`WwwRoute`. Deliberately its own
 * top-level route (not nested under `/admin`): `specs/end-to-end_encryption.md`'s "Separation of duties"
 * treats holding an `EscrowScope` as a distinct role from server administration - see `EscrowShell.tsx`'s
 * own doc comment on why this app has no "is this caller a trusted admin" gate the way `AdminShell` does,
 * only "is this caller signed in at all".
 */
@Route("/escrow")
export class EscrowConsoleRoute extends ReactRoute {
    protected readonly appDir: string = webClientAppDir("escrow");
    protected readonly hydrate: boolean = true;

    @Config("mail:auth_server_url")
    private authServerUrl?: string;

    @Inject(ObjectFactory)
    private brandingObjectFactory!: ObjectFactory;

    /** See `WwwRoute.fetchProps()` (`src/mongo/routes/wwwRoute.ts`) — identical purpose, for the escrow
     * console. No `impersonationBaseUrl` here (unlike `AdminConsoleRoute`) - this app never impersonates
     * a mailbox owner, it only ever acts as the signed-in holder themselves. */
    protected async fetchProps(_req: HttpRequest): Promise<any> {
        const { branding } = await fetchBrandingPropsForSSR(this.brandingObjectFactory, BrandingMongo);
        return { authServerUrl: this.authServerUrl, branding };
    }
}
