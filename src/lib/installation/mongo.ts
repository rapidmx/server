///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { AuditLogEntryMongo, DnsProviderMongo, DomainMongo, DomainSeederMongo, SetupStateMongo } from "@rapidmx/restapi/mongo";
import type { InstallationClasses } from "../seedInstallation.js";

/** What setting up the installation (`seedInstallation()`) uses on MongoDB. */
export const MONGO_INSTALLATION: InstallationClasses = {
    dnsProviderClass: DnsProviderMongo,
    domainClass: DomainMongo,
    setupStateClass: SetupStateMongo,
    auditLogClass: AuditLogEntryMongo,
    domainSeederClass: DomainSeederMongo,
};
