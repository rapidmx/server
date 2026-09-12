///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
import { selectConfigDrivenBackend } from "../../src/lib/configDrivenBackend.js";

function fakeConfig(value: unknown): { get(key: string): unknown } {
    return { get: () => value };
}

describe("selectConfigDrivenBackend", () => {
    it("resolves to the default option when the config key is unset", () => {
        expect(selectConfigDrivenBackend(fakeConfig(undefined), "mail:blob:backend", "s3", "local", "s3")).toBe("local");
    });

    it("resolves to the alternate option when the config value exactly matches alternateValue", () => {
        expect(selectConfigDrivenBackend(fakeConfig("s3"), "mail:blob:backend", "s3", "local", "s3")).toBe("s3");
    });

    it("resolves to the default option for any value other than an exact match, not just unset", () => {
        expect(selectConfigDrivenBackend(fakeConfig("something-else"), "mail:blob:backend", "s3", "local", "s3")).toBe("local");
    });

    it("is case-sensitive - a differently-cased match does not count as a match", () => {
        expect(selectConfigDrivenBackend(fakeConfig("S3"), "mail:blob:backend", "s3", "local", "s3")).toBe("local");
    });

    it("passes the exact config key through to config.get()", () => {
        const get = vi.fn().mockReturnValue("s3");
        selectConfigDrivenBackend({ get }, "mail:blob:backend", "s3", "local", "s3");
        expect(get).toHaveBeenCalledWith("mail:blob:backend");
    });

    it("returns the actual candidate values given (classes, not just strings)", () => {
        class Default {}
        class Alternate {}
        expect(selectConfigDrivenBackend(fakeConfig(undefined), "k", "alt", Default, Alternate)).toBe(Default);
        expect(selectConfigDrivenBackend(fakeConfig("alt"), "k", "alt", Default, Alternate)).toBe(Alternate);
    });
});
