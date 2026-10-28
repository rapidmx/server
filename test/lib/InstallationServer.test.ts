///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
// The server that does its installation's work (the DNS provider the installer created, the domains it was installed for) after its datastores are connected
// and its routes are registered, and before it listens, so that nothing is served, and the readiness probe doesn't pass, until that is done.
import { Server } from "@rapidrest/service-core";
import { InstallationServer } from "../../src/lib/InstallationServer.js";

describe("InstallationServer", () => {
    const config = { get: () => undefined };

    // Server registers its metrics in the process-wide registry, so one is built for the whole file.
    const beforeListening = vi.fn(async () => undefined);
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const server = new InstallationServer({ config, logger, classLoader: {} as any, objectFactory: {} as any }, beforeListening);

    it("is a Server, so it starts, serves and stops as every worker's does", () => {
        expect(server).toBeInstanceOf(Server);
    });

    it("runs its work in the Server's post-start step, which is after the datastores connect and before the server listens", async () => {
        await (server as any).postStart();
        expect(beforeListening).toHaveBeenCalledTimes(1);
    });

    it("runs again on a restart: its work is idempotent, and a restarted server needs it as much as the first start", async () => {
        beforeListening.mockClear();
        await (server as any).postStart();
        await (server as any).postStart();
        expect(beforeListening).toHaveBeenCalledTimes(2);
    });

    it("does not stop the server from starting when its work throws, which it doesn't, but a bug in it must not either", async () => {
        beforeListening.mockRejectedValueOnce(new Error("boom"));
        await expect((server as any).postStart()).resolves.toBeUndefined();
        expect(logger.error.mock.calls.flat().join("\n")).toContain("boom");
    });
});
