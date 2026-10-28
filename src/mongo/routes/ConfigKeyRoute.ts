///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
import { ConfigKeyRouteMongo } from "@rapidmx/restapi/mongo";
import { RouteDecorators } from "@rapidrest/service-core";

const { ApiRoute } = RouteDecorators;

// The configuration keyring's console: the keys by kid and age, never key material, and the rotation. Reads need a
// trusted role; starting a rotation and "Activate anyway" need an elevated token too, and are audited. The job that
// performs a rotation is ConfigKeyRotationJob (src/{mongo,sql}/Jobs.ts).
@ApiRoute("system/config-keys")
export class ConfigKeyRoute extends ConfigKeyRouteMongo {}
