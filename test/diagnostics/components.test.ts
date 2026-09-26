///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
import { classifyContainer, imageBasename, imageDigest, imageTag } from "../../src/diagnostics/components.js";

describe("classifyContainer", () => {
    it.each([
        ["postfix", "boky/postfix:latest", "postfix"],
        ["postfix-bridge", "ghcr.io/rapidmx/server:1.0.0", "postfix-bridge"],
        ["mongodb", "docker.io/bitnami/mongodb:8.0", "mongodb"],
        ["postgresql", "docker.io/bitnami/postgresql:17", "postgresql"],
        ["redis", "docker.io/bitnami/redis:8", "redis"],
        ["coturn", "docker.io/coturn/coturn:4.18.0", "coturn"],
        ["rspamd", "docker.io/rspamd/rspamd:4.1.5", "rspamd"],
        ["clamav", "docker.io/clamav/clamav:stable", "clamav"],
    ])("%s is %s by its name", (name, image, expected) => {
        expect(classifyContainer(name, image)).toBe(expected);
    });

    it("falls back to the image name", () => {
        expect(classifyContainer("db", "registry.local:5000/bitnami/mongodb:8@sha256:abc")).toBe("mongodb");
    });

    it("ignores sidecars and unrelated containers", () => {
        expect(classifyContainer("metrics", "bitnami/redis-exporter:1")).toBeUndefined();
        expect(classifyContainer("cache", "bitnami/redis-exporter:1")).toBeUndefined();
        expect(classifyContainer("certificate-reloader", "busybox")).toBeUndefined();
        expect(classifyContainer("server", "ghcr.io/rapidmx/server:1")).toBeUndefined();
    });
});

describe("image helpers", () => {
    it("takes the last path segment without tag or digest", () => {
        expect(imageBasename("docker.io/clamav/clamav:stable")).toBe("clamav");
        expect(imageBasename("localhost:5000/foo@sha256:abc")).toBe("foo");
    });

    it("finds the tag, ignoring a registry port", () => {
        expect(imageTag("docker.io/rspamd/rspamd:4.1.5")).toBe("4.1.5");
        expect(imageTag("localhost:5000/foo")).toBeUndefined();
        expect(imageTag("localhost:5000/foo:2@sha256:abc")).toBe("2");
    });

    it("finds a digest in an imageID", () => {
        const digest = `sha256:${"a".repeat(64)}`;
        expect(imageDigest(`docker.io/rspamd/rspamd@${digest}`)).toBe(digest);
        expect(imageDigest(digest)).toBe(digest);
        expect(imageDigest("nonsense")).toBeUndefined();
        expect(imageDigest(undefined)).toBeUndefined();
    });
});
