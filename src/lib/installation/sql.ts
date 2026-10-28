///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { AuditLogEntrySQL, DnsProviderSQL, DomainSeederSQL, DomainSQL, SetupStateSQL } from "@rapidmx/restapi/sql";
import type { InstallationClasses } from "../seedInstallation.js";

/** What setting up the installation (`seedInstallation()`) uses on SQL databases. */
export const SQL_INSTALLATION: InstallationClasses = {
    dnsProviderClass: DnsProviderSQL,
    domainClass: DomainSQL,
    setupStateClass: SetupStateSQL,
    auditLogClass: AuditLogEntrySQL,
    domainSeederClass: DomainSeederSQL,
};
