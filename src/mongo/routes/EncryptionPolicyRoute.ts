///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
import { EncryptionPolicyRouteMongo } from "@rapidmx/restapi/mongo";
import { RouteDecorators } from "@rapidrest/service-core";

const { ApiRoute } = RouteDecorators;

@ApiRoute("system/encryption-policy")
export class EncryptionPolicyRoute extends EncryptionPolicyRouteMongo {}
