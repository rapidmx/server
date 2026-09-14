///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////

let draining: boolean = false;

/**
 * Marks this process as about to stop for a plugin restart. `StatusRoute` - the readiness probe - then answers 503,
 * so the load balancer stops sending it traffic before its listener closes.
 */
export function setDraining(value: boolean): void {
    draining = value;
}

/** Whether this process is draining ahead of a plugin restart. */
export function isDraining(): boolean {
    return draining;
}
