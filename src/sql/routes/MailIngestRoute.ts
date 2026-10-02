///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
import { MailIngestRouteSQL } from "@rapidmx/restapi/sql";
import { ObjectDecorators } from "@rapidrest/core";
import { RouteDecorators } from "@rapidrest/service-core";
import { guardInternalCaller } from "../../lib/InternalCallerGuard.js";

const { Route } = RouteDecorators;
const { Config } = ObjectDecorators;

// Deliberately mounted outside of `/api` and authenticated via a bearer secret
// (`mail:transport:ingest:secret`), not JWT — this endpoint is the MTA (Postfix) hand-off contract, not a
// client-facing API. It must never be reachable through the public ingress: the Helm chart's HTTPRoute answers 404 for
// /internal, and guardInternalCaller() below makes the route itself refuse a request that carries proxy headers
// (`mail:internal:allow_forwarded` lifts that for an internal load balancer that adds them) and count the wrong secrets an address
// presents (a correct one is never turned away). Its only caller is the postfix-bridge container (see the separate
// github.com/rapidmx/postfix-bridge repo's src/index.ts) or ses-bridge's Lambda over mail.ingestService - Postfix itself
// never calls this route directly.
@Route("/internal/mta")
export class MailIngestRoute extends MailIngestRouteSQL {
    @Config("mail:internal:allow_forwarded", false)
    protected allowForwarded: boolean = false;

    /** Read by guardInternalCaller(): behind these, the caller is the client address in `X-Forwarded-For`. */
    @Config("trusted_proxies", [])
    protected trustedProxies: string[] = [];
}

guardInternalCaller(MailIngestRoute);
