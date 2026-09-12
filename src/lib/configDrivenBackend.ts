///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * Resolves a config-driven backend selector (`mail:blob:backend`, `mail:pki:signing_enrollment:backend`,
 * etc.) to one of two candidate classes, given the exact string value that opts into the non-default
 * option — any other value, including unset, resolves to `defaultOption`.
 *
 * Extracted out of `server.mongo.ts`/`server.sql.ts`'s own inline ternaries (`objectFactory.register(x
 * === "s3" ? S3BlobStore : LocalFsBlobStore, ...)`) so the selection logic itself is unit-testable
 * without importing those files - both run `void start(...)` unconditionally at module load with no
 * "only if this is the main module" guard, so importing either from a test process would attempt to
 * actually start a server (see `test/Server.mongo.test.ts`'s own doc comment on why it re-implements DI
 * registration instead of importing `server.mongo.ts` directly - the same constraint applies here).
 */
export function selectConfigDrivenBackend<A, B>(
    config: { get(key: string): unknown },
    key: string,
    alternateValue: string,
    defaultOption: A,
    alternateOption: B,
): A | B {
    const value: unknown = config.get(key);
    return value === alternateValue ? alternateOption : defaultOption;
}
