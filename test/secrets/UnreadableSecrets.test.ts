///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
import { ConfigSecretUnavailableError, type ConfigEnvelope } from "@rapidmx/restapi";
import { UnreadableSecrets } from "../../src/secrets/UnreadableSecrets.js";

const context = { record: "IntegrationSettings", uid: "integrations", field: "giphy.apiKey" };
const envelope = (iv: string): ConfigEnvelope => ({ $enc: 1, kid: "k1", iv, ct: "ct", tag: "tag" });
const unavailable = () => new ConfigSecretUnavailableError(context.record, context.uid, context.field, "unknown_key", "its key 'k1' isn't in the keyring");

describe("UnreadableSecrets", () => {
    beforeEach(() => UnreadableSecrets.reset());

    it("remembers the envelope that couldn't be decrypted, and only that one", () => {
        UnreadableSecrets.record(context, envelope("a"));
        expect(UnreadableSecrets.isUnreadable(context, envelope("a"))).toBe(true);
        // A secret saved again has a new nonce.
        expect(UnreadableSecrets.isUnreadable(context, envelope("b"))).toBe(false);
        expect(UnreadableSecrets.isUnreadable({ ...context, field: "pluginRegistry.token" }, envelope("a"))).toBe(false);
        expect(UnreadableSecrets.isUnreadable({ ...context, uid: "other" }, envelope("a"))).toBe(false);
        expect(UnreadableSecrets.isUnreadable(context, undefined)).toBe(false);
        expect(UnreadableSecrets.isUnreadable(context, "text")).toBe(false);
    });

    it("tracks a decryption: a failure to read the secret is recorded and rethrown, a read clears it", () => {
        expect(() =>
            UnreadableSecrets.track(context, envelope("a"), () => {
                throw unavailable();
            }),
        ).toThrow(ConfigSecretUnavailableError);
        expect(UnreadableSecrets.isUnreadable(context, envelope("a"))).toBe(true);
        expect(UnreadableSecrets.track(context, envelope("a"), () => "value")).toBe("value");
        expect(UnreadableSecrets.isUnreadable(context, envelope("a"))).toBe(false);
    });

    it("does not record an error that isn't about the secret", () => {
        expect(() =>
            UnreadableSecrets.track(context, envelope("a"), () => {
                throw new TypeError("a bug");
            }),
        ).toThrow(TypeError);
        expect(UnreadableSecrets.isUnreadable(context, envelope("a"))).toBe(false);
    });

    it("records something that isn't an envelope at all without failing", () => {
        UnreadableSecrets.record(context, undefined);
        UnreadableSecrets.record(context, "not an envelope");
        expect(UnreadableSecrets.isUnreadable(context, envelope("a"))).toBe(false);
    });

    it("remembers a bounded number of failures, forgetting the oldest", () => {
        for (let i = 0; i < 1005; i++) {
            UnreadableSecrets.record({ ...context, uid: `row-${i}` }, envelope("a"));
        }
        expect(UnreadableSecrets.isUnreadable({ ...context, uid: "row-0" }, envelope("a"))).toBe(false);
        expect(UnreadableSecrets.isUnreadable({ ...context, uid: "row-1004" }, envelope("a"))).toBe(true);
    });
});
