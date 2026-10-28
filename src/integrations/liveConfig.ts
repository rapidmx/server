///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { HostConfig } from "@rapidmx/restapi";

/**
 * The value of the configuration key `key` as it is now (restapi spec 11.3): read through `HostConfig` from the server's live configuration, whose integrations
 * layer an administrator's change in the console rebuilds, so a consumer that calls this at each use follows the change without a restart. A `@Config` field is
 * a copy taken when the object was built.
 *
 * In a process with no host (a test that builds a route by itself) nothing is installed and the value the object was built with, `startup`, is what applies.
 * With a host a key nothing sets is `undefined`, whatever `startup` is: the startup value is not a default.
 */
export function liveConfig<T = unknown>(key: string, startup?: T): T | undefined {
    return HostConfig.isInstalled() ? HostConfig.get<T>(key) : startup;
}
