///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { RouteDecorators } from "@rapidrest/service-core";
import { BaseStaticAssetRoute, STATIC_ASSET_PATHS } from "../../routes/BaseStaticAssetRoute.js";

const { Route } = RouteDecorators;

/** The browser build's bundles and static files, with cache headers and compression - see `BaseStaticAssetRoute`. */
@Route(STATIC_ASSET_PATHS)
export class StaticAssetRoute extends BaseStaticAssetRoute {}
