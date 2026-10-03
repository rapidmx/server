///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
// The `@Init` hooks of the server's own routes: each builds its repositories and services once, through the
// ObjectFactory, and the handlers never build them lazily.
import "reflect-metadata";
import { ConnectionManager, RepoUtils } from "@rapidrest/service-core";
import { DiagnosticsCollector } from "../../src/diagnostics/DiagnosticsCollector.js";
import { PluginPurgeLedger } from "../../src/plugins/PluginPurgeLedger.js";
import { PluginPurgeStore } from "../../src/plugins/PluginPurgeStore.js";
import { BaseDiagnosticsRoute } from "../../src/routes/BaseDiagnosticsRoute.js";
import { BaseEscrowInfoRoute } from "../../src/routes/BaseEscrowInfoRoute.js";
import { BaseMailComposeRoute } from "../../src/routes/BaseMailComposeRoute.js";
import { withPluginPurge } from "../../src/routes/PluginPurgeRoutes.js";

class MailboxModel {}
class EscrowScopeModel {}
class MessageModel {}
class AttachmentModel {}
class FolderModel {}
class MatterModel {}

class TestEscrowInfoRoute extends BaseEscrowInfoRoute<any> {
    protected mailboxClass: any = MailboxModel;
    protected escrowScopeClass: any = EscrowScopeModel;
}

class TestMailComposeRoute extends BaseMailComposeRoute<any, any, any, any> {
    protected messageClass: any = MessageModel;
    protected attachmentClass: any = AttachmentModel;
    protected mailboxClass: any = MailboxModel;
    protected folderClass: any = FolderModel;
    protected matterClass: any = MatterModel;
}

class TestDiagnosticsRoute extends BaseDiagnosticsRoute {}

class FakePluginRoute {
    async list(): Promise<any[]> {
        return [];
    }
    async status(): Promise<any> {
        return {};
    }
    async remove(): Promise<any> {
        return undefined;
    }
    async add(): Promise<any> {
        return {};
    }
    async plan(): Promise<any> {
        return {};
    }
}
class PurgeModel {}
const TestPurgeRoute: any = withPluginPurge(FakePluginRoute as any, { datastore: "sql", purgeClass: PurgeModel });

function withFactory(route: any, extra: Record<string, unknown> = {}): any {
    const factory: any = { newInstance: vi.fn(async (type: any, opts: any) => ({ type, opts })), ...extra };
    Object.defineProperty(route, "_objectFactory", { value: factory, writable: true, configurable: true });
    return factory;
}

const repoCases: { name: string; make: () => any; hook: string; repos: [string, string][] }[] = [
    {
        name: "BaseEscrowInfoRoute",
        make: () => new TestEscrowInfoRoute(),
        hook: "initializeEscrowInfo",
        repos: [
            ["mailboxRepo", "mailboxClass"],
            ["escrowScopeRepo", "escrowScopeClass"],
        ],
    },
    {
        name: "BaseMailComposeRoute",
        make: () => new TestMailComposeRoute(),
        hook: "initializeCompose",
        repos: [
            ["messageRepo", "messageClass"],
            ["attachmentRepo", "attachmentClass"],
            ["mailboxRepo", "mailboxClass"],
            ["folderRepo", "folderClass"],
            ["matterRepo", "matterClass"],
        ],
    },
];

describe.each(repoCases)("$name $hook()", ({ make, hook, repos }) => {
    it("throws when the objectFactory is not set", async () => {
        await expect(make()[hook]()).rejects.toThrow("objectFactory is not set.");
    });

    it("builds each repo once through the factory with exactly its name and class", async () => {
        const route: any = make();
        const factory = withFactory(route);
        await route[hook]();
        expect(factory.newInstance).toHaveBeenCalledTimes(repos.length);
        for (const [field, classField] of repos) {
            const cls = route[classField];
            expect(factory.newInstance).toHaveBeenCalledWith(RepoUtils, { name: cls.name, args: [cls] });
            expect(route[field]).toEqual({ type: RepoUtils, opts: { name: cls.name, args: [cls] } });
        }
    });

    it("does not rebuild a repo that is already set", async () => {
        const route: any = make();
        const factory = withFactory(route);
        const preset = repos.map(([field]) => (route[field] = { preset: field }));
        await route[hook]();
        expect(factory.newInstance).not.toHaveBeenCalled();
        repos.forEach(([field], i) => expect(route[field]).toBe(preset[i]));
    });

    it("skips a repo whose model class is unset", async () => {
        const route: any = make();
        const factory = withFactory(route);
        for (const [, classField] of repos) {
            route[classField] = undefined;
        }
        await route[hook]();
        expect(factory.newInstance).not.toHaveBeenCalled();
    });
});

describe("BaseDiagnosticsRoute initializeDiagnostics()", () => {
    it("throws when the objectFactory is not set", async () => {
        await expect((new TestDiagnosticsRoute() as any).initializeDiagnostics()).rejects.toThrow("objectFactory is not set.");
    });

    it("builds the one collector through the factory with the configured namespace and timeout", async () => {
        const route: any = new TestDiagnosticsRoute();
        route.namespace = "mail";
        route.timeoutMs = "2500";
        const factory = withFactory(route);
        await route.initializeDiagnostics();
        expect(factory.newInstance).toHaveBeenCalledTimes(1);
        expect(factory.newInstance).toHaveBeenCalledWith(DiagnosticsCollector, { name: "DiagnosticsCollector", args: [{ namespace: "mail", timeoutMs: 2500 }] });
        expect(route.collector.type).toBe(DiagnosticsCollector);
    });

    it("does not rebuild a collector that is already set", async () => {
        const route: any = new TestDiagnosticsRoute();
        const factory = withFactory(route);
        const preset = (route.collector = { preset: true });
        await route.initializeDiagnostics();
        expect(factory.newInstance).not.toHaveBeenCalled();
        expect(route.collector).toBe(preset);
    });
});

describe("withPluginPurge initializePurgeLedger()", () => {
    const connection = { name: "sql-connection" };
    const connections = new Map<string, any>([["sql", connection]]);

    it("throws when the objectFactory is not set", async () => {
        await expect(new TestPurgeRoute().initializePurgeLedger()).rejects.toThrow("objectFactory is not set.");
    });

    it("throws when there is no ConnectionManager", async () => {
        const route: any = new TestPurgeRoute();
        withFactory(route, { getInstance: vi.fn(() => undefined) });
        await expect(route.initializePurgeLedger()).rejects.toThrow("ConnectionManager is not available.");
    });

    it("builds the store and then the ledger through the factory, with the configured lease", async () => {
        const route: any = new TestPurgeRoute();
        route.purgeLeaseMs = "45000";
        const factory = withFactory(route, { getInstance: vi.fn(() => ({ connections })) });
        await route.initializePurgeLedger();
        expect(factory.getInstance).toHaveBeenCalledWith(ConnectionManager);
        expect(factory.newInstance).toHaveBeenCalledTimes(2);
        const storeOpts = { name: "PurgeModel", args: [connection, PurgeModel] };
        expect(factory.newInstance).toHaveBeenNthCalledWith(1, PluginPurgeStore, storeOpts);
        expect(factory.newInstance).toHaveBeenNthCalledWith(2, PluginPurgeLedger, { name: "PurgeModel", args: [{ type: PluginPurgeStore, opts: storeOpts }, 45000] });
        expect(route.getPurgeLedger()).toBe(route.purgeLedger);
    });

    it("does not rebuild a ledger that is already set", async () => {
        const route: any = new TestPurgeRoute();
        const factory = withFactory(route, { getInstance: vi.fn(() => ({ connections })) });
        const preset = (route.purgeLedger = { preset: true });
        await route.initializePurgeLedger();
        expect(factory.newInstance).not.toHaveBeenCalled();
        expect(route.getPurgeLedger()).toBe(preset);
    });
});
