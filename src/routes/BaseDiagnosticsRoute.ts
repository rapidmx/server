///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
import { ObjectDecorators } from "@rapidrest/core";
import { DocDecorators, RouteDecorators } from "@rapidrest/service-core";
import { DiagnosticsCollector } from "../diagnostics/DiagnosticsCollector.js";
import type { DiagnosticsMetrics, DiagnosticsRuntime, DiagnosticsVersions } from "../diagnostics/types.js";

const { Config } = ObjectDecorators;
const { Description, Returns, Summary } = DocDecorators;
const { Auth, Get, RequiresElevation, RequiresTrustedRole } = RouteDecorators;

/**
 * What the admin console's Diagnostics page reads to help troubleshoot a deployment: the server's own versions and
 * installed packages, the other containers' versions and health, the Kubernetes runtime, and live CPU, memory, disk and
 * PVC usage (of the node the server runs on, the namespace's pods and the PVCs the server has mounted). Trusted role and an elevated token only, like the rest of `/api/admin` (`BaseAdminRoute`, whose `/logs`
 * WebSocket the page's log viewer connects to).
 *
 * Kubernetes is asked with the pod's own service account (see `diagnostics/KubeClient.ts`), which the Helm chart gives read access to pods,
 * PVCs and pod metrics in its own namespace only (`global.diagnostics.rbac.create`; no cluster-wide access). Wherever that is missing - Docker Compose, `yarn dev`, RBAC
 * turned off - the Kubernetes parts answer `available: false` with the reason and everything else still works.
 */
@RequiresElevation()
export abstract class BaseDiagnosticsRoute {
    @Config("diagnostics:namespace", "")
    private namespace!: string;

    @Config("diagnostics:timeout_ms", 5000)
    private timeoutMs!: number;

    private collector?: DiagnosticsCollector;

    private get diagnostics(): DiagnosticsCollector {
        this.collector ??= new DiagnosticsCollector({
            namespace: this.namespace,
            timeoutMs: Number(this.timeoutMs),
        });
        return this.collector;
    }

    @Summary("Server and container versions")
    @Description(
        "Returns the server's Node.js and package versions, every installed package, and the version and health of the other containers (postfix, mongodb, postgresql, redis, coturn, rspamd, clamav, postfix-bridge)."
    )
    @Auth(["jwt"])
    @Get("/versions")
    @Returns([Object])
    @RequiresTrustedRole()
    public versions(): Promise<DiagnosticsVersions> {
        return this.diagnostics.versions();
    }

    @Summary("Kubernetes runtime")
    @Description("Returns the Kubernetes version and the nodes running the namespace's pods.")
    @Auth(["jwt"])
    @Get("/runtime")
    @Returns([Object])
    @RequiresTrustedRole()
    public runtime(): Promise<DiagnosticsRuntime> {
        return this.diagnostics.runtime();
    }

    @Summary("Live resource usage")
    @Description("Returns a sample of CPU, memory and disk usage of the node the server runs on, of the namespace's pods and PVCs, and of this server process.")
    @Auth(["jwt"])
    @Get("/metrics")
    @Returns([Object])
    @RequiresTrustedRole()
    public metrics(): Promise<DiagnosticsMetrics> {
        return this.diagnostics.metrics();
    }
}
