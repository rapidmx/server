///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { MailIngestRouteSQL } from "@rapidmx/restapi/sql";
import { DevLocalDeliveryTransport } from "./DevLocalDeliveryTransport.js";

/** DEV-ONLY: `DevLocalDeliveryTransport` for the SQL datastores. */
export class DevLocalDeliveryTransportSQL extends DevLocalDeliveryTransport {
    protected readonly ingestRouteClass: any = MailIngestRouteSQL;
}
