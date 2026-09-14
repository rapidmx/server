///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ApiError } from "@rapidrest/core";
import { ApiErrors, BaseStatusRoute } from "@rapidrest/service-core";
import { isDraining } from "../plugins/readiness.js";

/**
 * The server status endpoint, which is also the Helm chart's readiness probe. It answers 503 while this process is
 * draining ahead of a plugin restart, so the load balancer takes it out of rotation before its listener closes.
 */
export class BaseReadinessStatusRoute extends BaseStatusRoute {
    public get(): any {
        if (isDraining()) {
            throw new ApiError(ApiErrors.INTERNAL_ERROR, 503, "The server is restarting to apply plugin changes.");
        }
        return super.get();
    }
}
