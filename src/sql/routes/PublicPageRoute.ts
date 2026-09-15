///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
import { ObjectDecorators } from "@rapidrest/core";
import { ReactRoute } from "@rapidrest/react";
import { ObjectFactory, type HttpRequest } from "@rapidrest/service-core";
import { fetchBrandingPropsForSSR } from "@rapidmx/restapi";
import { BrandingSQL } from "@rapidmx/restapi/sql";

const { Inject } = ObjectDecorators;

/**
 * The base of the public, unauthenticated page hosts: `BookRoute` and plugin UI apps on the `public` host. Pages are
 * hydrated and get this deployment's branding, so the first byte already has the right title, favicon and stylesheet.
 * Not mounted itself (no `@Route`).
 */
export class PublicPageRoute extends ReactRoute {
    protected readonly hydrate: boolean = true;

    @Inject(ObjectFactory)
    private brandingObjectFactory!: ObjectFactory;

    protected async fetchProps(_req: HttpRequest): Promise<any> {
        return await fetchBrandingPropsForSSR(this.brandingObjectFactory, BrandingSQL);
    }
}
