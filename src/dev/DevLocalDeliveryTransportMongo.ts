///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { MailIngestRouteMongo } from "@rapidmx/restapi/mongo";
import { DevLocalDeliveryTransport } from "./DevLocalDeliveryTransport.js";

/** DEV-ONLY: `DevLocalDeliveryTransport` for the MongoDB datastore. */
export class DevLocalDeliveryTransportMongo extends DevLocalDeliveryTransport {
    protected readonly ingestRouteClass: any = MailIngestRouteMongo;
}
