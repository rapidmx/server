///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz <caskater47@gmail.com>
///////////////////////////////////////////////////////////////////////////////
import { RouteDecorators } from "@rapidrest/service-core";
import { BaseReadinessStatusRoute } from "../../routes/BaseReadinessStatusRoute.js";
const { ApiRoute } = RouteDecorators;

@ApiRoute("/status")
export class StatusRoute extends BaseReadinessStatusRoute {}