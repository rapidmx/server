///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
import { EncryptionPolicyRouteSQL } from "@rapidmx/restapi/sql";
import { RouteDecorators } from "@rapidrest/service-core";

const { ApiRoute } = RouteDecorators;

@ApiRoute("system/encryption-policy")
export class EncryptionPolicyRoute extends EncryptionPolicyRouteSQL {}
