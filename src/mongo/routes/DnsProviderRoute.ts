///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
import { type ConfigCipher, type PublicDnsProvider } from "@rapidmx/restapi";
import { DnsProviderRouteMongo as RestapiDnsProviderRoute } from "@rapidmx/restapi/mongo";
import { RouteDecorators } from "@rapidrest/service-core";
import { markUnreadableCredentials } from "../../secrets/markUnreadableCredentials.js";

const { ApiRoute } = RouteDecorators;

// restapi's route, typed without its private toPublic(), which this replaces (a subclass may not redeclare a private member), and with its injected cipher.
const DnsProviderRoutePrivates = RestapiDnsProviderRoute as unknown as new () => {
    cipher?: Pick<ConfigCipher, "loadedKids">;
    toPublic(provider: any, domainCount: number): PublicDnsProvider;
};

// The DNS provider configs an administrator manages: credentials are encrypted in their row, shown as masks and never returned. Reads need a trusted role;
// writes and the queued test and takeover operations need an elevated token too, and are audited. restapi's views never decrypt, so they show every
// credential as a plain mask; this marks one as unreadable that this process has already failed to decrypt, or whose key it hasn't loaded (neither by
// decrypting for the request), so the console can ask for it again.
@ApiRoute("system/dns-providers")
export class DnsProviderRoute extends DnsProviderRoutePrivates {
    public toPublic(provider: any, domainCount: number): PublicDnsProvider {
        return markUnreadableCredentials(super.toPublic(provider, domainCount), provider, this.cipher);
    }
}
