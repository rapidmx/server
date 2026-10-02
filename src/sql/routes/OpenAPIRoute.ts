///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz <caskater47@gmail.com>
///////////////////////////////////////////////////////////////////////////////
import { BaseOpenAPIRoute, RouteDecorators } from "@rapidrest/service-core";
const { ApiRoute, Auth } = RouteDecorators;

// The description lists every route the server mounts, the admin, escrow and plugin ones included, so it is only given to
// signed-in callers. The overrides keep the base class's paths and docs (the framework merges the decorators of an
// overridden method with the inherited ones) and add the authentication.
@ApiRoute("/openapi")
export class OpenAPIRoute extends BaseOpenAPIRoute {
    @Auth(["jwt"])
    public getHTML(): string {
        return super.getHTML();
    }

    @Auth(["jwt"])
    public getJSON(): any {
        return super.getJSON();
    }

    @Auth(["jwt"])
    public getYAML(): string {
        return super.getYAML();
    }
}
