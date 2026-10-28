///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
import { DnsDesiredStateRouteSQL } from "@rapidmx/restapi/sql";
import { ObjectDecorators } from "@rapidrest/core";
import { RouteDecorators } from "@rapidrest/service-core";
import { guardInternalCaller } from "../../lib/InternalCallerGuard.js";

const { Route } = RouteDecorators;
const { Config } = ObjectDecorators;

// The DNS controller's API: its handshake, the long-polled desired state, its status reports and the credentials it writes the external-dns Secrets from.
// Deliberately mounted outside of `/api`, like `/internal/mta`, and authenticated by the controller's projected ServiceAccount token alone (restapi's
// route verifies it with the DnsControllerTokenVerifier the server registers and compares its subject with `mail:dns:controller:subject`), never a user's
// JWT. It must never be reachable through the public ingress: the Helm chart's HTTPRoute answers 404 for /internal, and guardInternalCaller() below makes the
// route itself refuse a request that carries proxy headers (`mail:internal:allow_forwarded` lifts that for an internal load balancer that adds them) and count
// the wrong tokens an address presents (the controller's own is never turned away). It is plain HTTP inside the cluster, like /internal/mta.
@Route("/internal/dns")
export class DnsDesiredStateRoute extends DnsDesiredStateRouteSQL {
    @Config("mail:internal:allow_forwarded", false)
    protected allowForwarded: boolean = false;

    /** Read by guardInternalCaller(): behind these, the caller is the client address in `X-Forwarded-For`. */
    @Config("trusted_proxies", [])
    protected trustedProxies: string[] = [];
}

// restapi's route checks its caller in authorize(), which each of its handlers awaits first.
guardInternalCaller(DnsDesiredStateRoute, undefined, "authorize");
