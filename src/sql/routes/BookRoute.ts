///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
import { RouteDecorators } from "@rapidrest/service-core";
import { PublicPageRoute } from "./PublicPageRoute.js";

const { Route } = RouteDecorators;

/**
 * The public, entirely unauthenticated booking pages (`apps/book/**`) — a visitor with nothing but a
 * `/book/:slug` link picks a slot and books it, or later manages it via `/book/manage/:token`. Unlike
 * `WwwRoute`/`AdminConsoleRoute` this needs no `authServerUrl`/impersonation wiring, but it's the most
 * likely of the three apps to be an anonymous visitor's very first (and possibly only) page, so it still
 * gets the same branding `fetchProps()` (see `PublicPageRoute`) for a correctly server-rendered title/favicon/stylesheet.
 */
@Route("/book")
export class BookRoute extends PublicPageRoute {
    protected readonly appDir: string = "apps/book";
}
