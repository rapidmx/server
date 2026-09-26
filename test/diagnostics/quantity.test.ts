///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
import { parseQuantity } from "../../src/diagnostics/quantity.js";

describe("parseQuantity", () => {
    it.each([
        ["250m", 0.25],
        ["100n", 1e-7],
        ["2", 2],
        ["1.5", 1.5],
        ["4045064Ki", 4045064 * 1024],
        ["10Gi", 10 * 1024 ** 3],
        ["129M", 129e6],
        ["1e3", 1000],
        ["2E", 2e18],
        [" 5k ", 5000],
    ])("reads %s", (input, expected) => {
        expect(parseQuantity(input)).toBeCloseTo(expected, 9);
    });

    it("passes finite numbers through and rejects everything else", () => {
        expect(parseQuantity(7)).toBe(7);
        expect(parseQuantity(NaN)).toBeUndefined();
        expect(parseQuantity(undefined)).toBeUndefined();
        expect(parseQuantity({})).toBeUndefined();
        expect(parseQuantity("lots")).toBeUndefined();
        expect(parseQuantity("5Zi")).toBeUndefined();
        expect(parseQuantity("")).toBeUndefined();
    });
});
