///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////

const SUFFIXES: Record<string, number> = {
    n: 1e-9,
    u: 1e-6,
    m: 1e-3,
    "": 1,
    k: 1e3,
    K: 1e3,
    M: 1e6,
    G: 1e9,
    T: 1e12,
    P: 1e15,
    E: 1e18,
    Ki: 1024,
    Mi: 1024 ** 2,
    Gi: 1024 ** 3,
    Ti: 1024 ** 4,
    Pi: 1024 ** 5,
    Ei: 1024 ** 6,
};

/**
 * Parses a Kubernetes resource quantity (`"250m"` CPU, `"4045064Ki"` memory, `"1e3"`, `"10Gi"`) into a plain number: cores
 * for a CPU, bytes for memory and storage. Returns `undefined` for anything that is not a quantity.
 */
export function parseQuantity(value: unknown): number | undefined {
    if (typeof value === "number") {
        return Number.isFinite(value) ? value : undefined;
    }
    if (typeof value !== "string") {
        return undefined;
    }
    const match = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)([a-zA-Z]{0,2})$/.exec(value.trim());
    if (!match) {
        return undefined;
    }
    // A bare `E` after digits is the exa suffix, not an exponent: "2E" would otherwise be rejected by the number part.
    const scale = SUFFIXES[match[2]];
    if (scale === undefined) {
        return undefined;
    }
    return Number(match[1]) * scale;
}
