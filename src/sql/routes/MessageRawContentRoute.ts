///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
import { MessageSQL } from "@rapidmx/restapi/sql";
import { RouteDecorators } from "@rapidrest/service-core";
import { BaseMessageRawContentRoute } from "../../routes/BaseMessageRawContentRoute.js";

const { ApiRoute } = RouteDecorators;

@ApiRoute("mail/messages")
export class MessageRawContentRoute extends BaseMessageRawContentRoute<MessageSQL> {
    protected messageClass: any = MessageSQL;
}
