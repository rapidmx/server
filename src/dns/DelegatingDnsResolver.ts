///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ObjectDecorators } from "@rapidrest/core";
import { NodeDnsResolver, type DnsMxRecord, type DnsResolver, type DnsSrvRecord } from "@rapidmx/restapi";
import { liveConfig } from "../integrations/liveConfig.js";
import { DohDnssecDnsResolver } from "./DohDnssecDnsResolver.js";
const { Config, Inject } = ObjectDecorators;

/**
 * The `DnsResolver` the server registers (restapi spec 11.3): hands each lookup to Node's own resolver (`mail:dns:resolver` `node`, the default) or to the
 * DNSSEC-validating DoH one (`doh-dnssec`), whichever the configuration names *at that moment*, so the resolver an administrator picks in the console's
 * Integrations answers the very next DNS check, verification and key discovery, without a restart. Where the DoH resolver asks is read at each lookup too
 * (`DohDnssecDnsResolver`). Any other value is Node's resolver, as the shipped configuration has always read it.
 *
 * Neither resolver keeps an answer (each lookup is a fresh query), so a switch has no cached answers to drop; if one ever caches, it has to be emptied here.
 */
export class DelegatingDnsResolver implements DnsResolver {
    // The resolver configured when the server started: it applies in a process with no host. Otherwise `mail:dns:resolver` is read at each lookup.
    @Config("mail:dns:resolver", "node")
    private configuredMode: unknown = "node";

    @Inject(NodeDnsResolver)
    private node?: DnsResolver;

    @Inject(DohDnssecDnsResolver)
    private doh?: DnsResolver;

    /** The resolver in force now. */
    private current(): DnsResolver {
        return liveConfig("mail:dns:resolver", this.configuredMode) === "doh-dnssec" ? this.doh! : this.node!;
    }

    public resolveTxt(hostname: string): Promise<string[][]> {
        return this.current().resolveTxt(hostname);
    }

    public resolveMx(hostname: string): Promise<DnsMxRecord[]> {
        return this.current().resolveMx(hostname);
    }

    public resolveCname(hostname: string): Promise<string[]> {
        return this.current().resolveCname(hostname);
    }

    public resolveSrv(hostname: string): Promise<DnsSrvRecord[]> {
        return this.current().resolveSrv(hostname);
    }
}
