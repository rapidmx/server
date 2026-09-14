///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { fork, type ChildProcess } from "child_process";
import { fileURLToPath } from "url";

/** The message a worker sends before exiting when it wants to be started again (its plugin set changed). */
export const RESTART_MESSAGE = { type: "rapidmx:restart" };

/** The message a worker sends once its server is listening. A failed exit soon after this counts as a failed start. */
export const LISTENING_MESSAGE = { type: "rapidmx:listening" };

/** The message type a worker sends once it has loaded at least one plugin's classes, with the plugin-state `hash` of
 * the set it loaded. Only failed starts after this can be the plugins' fault, so only they lead to safe mode. */
export const PLUGINS_LOADED_MESSAGE_TYPE = "rapidmx:plugins-loaded";

/** Set on the environment of the process the supervisor starts. */
export const WORKER_ENV = "RAPIDMX_WORKER";

/** Set on a safe-mode worker's environment: the plugin-state hash of the plugin set that kept failing. */
export const SAFE_MODE_BASELINE_ENV = "RAPIDMX_PLUGINS_SAFE_MODE_BASELINE";

/** Set on a safe-mode worker's environment: how many times in a row the server has fallen back to safe mode (1 the
 * first time), so its retries back off. */
export const SAFE_MODE_ATTEMPT_ENV = "RAPIDMX_PLUGINS_SAFE_MODE_ATTEMPT";

/**
 * The Node flags the worker starts with: the supervisor's own (so loaders such as tsx carry over), except that an
 * `--inspect` flag moves to the next port - the supervisor already holds the requested one, and the worker is
 * the process worth debugging.
 */
export function workerExecArgv(execArgv: string[]): string[] {
    return execArgv.map((arg) => {
        const match: RegExpMatchArray | null = arg.match(/^(--inspect(?:-brk|-wait)?)(?:=(?:(.*):)?(\d+))?$/);
        if (!match) {
            return arg;
        }
        const [, flag, host, port] = match;
        const next: number = (port ? Number(port) : 9229) + 1;
        return `${flag}=${host ? `${host}:` : ""}${next}`;
    });
}

export interface SupervisorOptions {
    /** How soon after the worker reports it is listening (or after it was started, if it never did) a failed exit
     * counts as a failed start. */
    fastFailureMs?: number;
    /** Failed starts in a row before the supervisor gives up: the next start is in safe mode (no plugins) if every one
     * of them had loaded plugins, and otherwise the supervisor exits. */
    maxFastFailures?: number;
    logger?: { info(msg: string): void; warn(msg: string): void; error(msg: string): void };
    /** Called with the supervisor's own exit code - replaceable for tests. */
    exit?: (code: number) => void;
    safeModeEnv?: string;
}

/**
 * Runs the server in a child process and starts it again when it asks to be restarted.
 *
 * Plugins add routes, database models and background jobs that the server only sets up at startup, and Node
 * caches every imported module for the life of a process - so applying a plugin change needs a fresh process,
 * which this supervisor provides without the container itself restarting.
 *
 * If the server keeps failing shortly after it loaded its plugins (for example a broken plugin), the next start is in
 * safe mode: no plugins at all, so mail keeps flowing while an administrator fixes or disables the plugin. The
 * safe-mode server tries the plugins again now and then (see `PluginWatcher`), backing off each time it ends up back in
 * safe mode. Failed starts before any plugin loaded (say, the database is down) aren't the plugins' fault: after
 * `maxFastFailures` of them the supervisor exits, as it does on any other exit, so the container's own restart policy
 * applies.
 */
export function superviseWorker(workerUrl: URL, options: SupervisorOptions = {}): { stop: (signal: NodeJS.Signals) => void } {
    const fastFailureMs: number = options.fastFailureMs ?? 60_000;
    const maxFastFailures: number = options.maxFastFailures ?? 2;
    const safeModeEnv: string = options.safeModeEnv ?? "RAPIDMX_PLUGINS_SAFE_MODE";
    const log = options.logger ?? console;
    const exit = options.exit ?? ((code: number) => process.exit(code));

    let child: ChildProcess | undefined;
    let stopping: boolean = false;
    let fastFailures: number = 0;
    let pluginFailures: number = 0;
    let safeModeAttempts: number = 0;

    const start = (safeMode: boolean, failedHash?: string): void => {
        // Measured from when the server is listening, so time spent installing plugins doesn't count.
        let startedAt: number = Date.now();
        let restartRequested: boolean = false;
        let loadedHash: string | undefined;
        const env: NodeJS.ProcessEnv = { ...process.env, [WORKER_ENV]: "1" };
        if (safeMode) {
            env[safeModeEnv] = "1";
            env[SAFE_MODE_ATTEMPT_ENV] = String(safeModeAttempts);
            if (failedHash) {
                env[SAFE_MODE_BASELINE_ENV] = failedHash;
            }
        }
        child = fork(fileURLToPath(workerUrl), process.argv.slice(2), { env, stdio: "inherit", execArgv: workerExecArgv(process.execArgv) });
        child.on("message", (message: any) => {
            if (message?.type === RESTART_MESSAGE.type) {
                restartRequested = true;
            } else if (message?.type === LISTENING_MESSAGE.type) {
                startedAt = Date.now();
            } else if (message?.type === PLUGINS_LOADED_MESSAGE_TYPE) {
                loadedHash = typeof message.hash === "string" ? message.hash : "";
            }
        });
        child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
            child = undefined;
            if (stopping) {
                exit(code ?? 0);
                return;
            }
            if (restartRequested) {
                log.info(safeMode ? "Restarting the server to try its plugins again." : "Restarting the server to apply plugin changes.");
                fastFailures = 0;
                pluginFailures = 0;
                if (!safeMode) {
                    // A server that ran its plugins long enough to see them change: safe mode starts over at the first retry delay.
                    safeModeAttempts = 0;
                }
                start(false);
                return;
            }
            const failed: boolean = code !== 0 || signal !== null;
            if (failed && !safeMode && Date.now() - startedAt < fastFailureMs) {
                fastFailures++;
                if (loadedHash !== undefined) {
                    pluginFailures++;
                    if (pluginFailures >= maxFastFailures) {
                        safeModeAttempts++;
                        log.error(`The server failed to start ${pluginFailures} times in a row after loading its plugins; starting it without plugins.`);
                        start(true, loadedHash);
                        return;
                    }
                } else if (fastFailures >= maxFastFailures) {
                    log.error(`The server failed to start ${fastFailures} times in a row before loading any plugins.`);
                    exit(code ?? 1);
                    return;
                }
                log.warn(`The server exited (${signal ?? code}) shortly after starting; starting it again.`);
                start(false);
                return;
            }
            exit(code ?? 1);
        });
    };

    const stop = (signal: NodeJS.Signals): void => {
        stopping = true;
        if (child) {
            child.kill(signal);
        } else {
            exit(0);
        }
    };
    start(false);
    return { stop };
}

/** Tells the supervisor (if any) that this process's server is listening. */
export function notifyListening(): void {
    if (process.send && process.env[WORKER_ENV] === "1") {
        process.send(LISTENING_MESSAGE);
    }
}

/** Tells the supervisor (if any) that this process has loaded the classes of the plugin set with plugin-state `hash`. */
export function notifyPluginsLoaded(hash: string): void {
    if (process.send && process.env[WORKER_ENV] === "1") {
        process.send({ type: PLUGINS_LOADED_MESSAGE_TYPE, hash });
    }
}

export interface RestartWorkerOptions {
    logger?: { info(msg: string): void; error(msg: string): void };
    /** How long stopping may take before the process exits anyway. */
    timeoutMs?: number;
    /** Replaceable for tests. */
    exit?: () => void;
}

/**
 * Stops this process's server with `stop` and exits for a restart - even if `stop` fails, or hasn't finished within
 * `timeoutMs`, so a server that can't stop cleanly isn't left running without its plugin watcher.
 */
export async function restartWorker(stop: () => Promise<void>, options: RestartWorkerOptions = {}): Promise<void> {
    const { logger, timeoutMs = 30_000, exit = exitForRestart } = options;
    let exited: boolean = false;
    const exitOnce = (): void => {
        if (!exited) {
            exited = true;
            exit();
        }
    };
    const timer: NodeJS.Timeout = setTimeout(() => {
        logger?.error(`Stopping the server took longer than ${Math.round(timeoutMs / 1000)}s; restarting anyway.`);
        exitOnce();
    }, timeoutMs);
    try {
        logger?.info("Restarting to apply plugin changes...");
        await stop();
    } catch (err: any) {
        logger?.error(`The server didn't stop cleanly before restarting: ${err?.message ?? err}`);
    } finally {
        clearTimeout(timer);
        exitOnce();
    }
}

/** Tells the supervisor (if any) that this process should be started again, then exits. */
export function exitForRestart(): void {
    if (process.send && process.env[WORKER_ENV] === "1") {
        process.send(RESTART_MESSAGE, () => process.exit(0));
    } else {
        // Not supervised (e.g. run directly): exit and leave restarting to whatever runs the process.
        process.exit(0);
    }
}
