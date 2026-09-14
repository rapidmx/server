#!/usr/bin/env node
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// The process a deployment runs. It starts the actual server (worker.sql.ts) as a child process and starts it
// again when its plugins change - see plugins/supervisor.ts for why that needs a new process.
import { superviseWorker } from "./plugins/supervisor.js";

const worker = new URL(import.meta.url.endsWith(".ts") ? "./worker.sql.ts" : "./worker.sql.js", import.meta.url);
const supervisor = superviseWorker(worker);

process.on("SIGINT", () => supervisor.stop("SIGINT"));
process.on("SIGTERM", () => supervisor.stop("SIGTERM"));
