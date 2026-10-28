///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

// What the installer tests share: running the functions of an installer (single_node_install.sh, deploy/aws/bootstrap.sh) under bash with
// kubectl, helm, openssl and the like replaced by stubs that record what they were asked to do, so a function can be checked without a cluster.
// Skipped where there's no bash (on Windows, Git for Windows' bash is used: the one on PATH may be WSL's).
export const BASH = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash";
export const bashAvailable = spawnSync(BASH, ["-c", "true"]).status === 0;

export const ROOT = path.resolve(__dirname, "../..");
export const INSTALLERS: Record<string, string> = {
    "single_node_install.sh": path.join(ROOT, "single_node_install.sh"),
    "deploy/aws/bootstrap.sh": path.join(ROOT, "deploy/aws/bootstrap.sh"),
};

/** The shell stubs and the fake `bao` the captured pod scripts run against. */
export const FIXTURES = path.join(__dirname, "../fixtures/installer");

/** The text of every `function name() { ... }` in `file`, so they can be sourced without running the script. */
export function functionsOf(file: string): string {
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    const out: string[] = [];
    let inside = false;
    // The terminator of the here-document being read, whose lines (a policy's closing braces, say) are text, not the function's end.
    let heredoc: string | undefined;
    for (const line of lines) {
        if (/^function [A-Za-z0-9_]+\(\) \{$/.test(line)) {
            inside = true;
        }
        if (!inside) {
            continue;
        }
        out.push(line);
        if (heredoc !== undefined) {
            if (line === heredoc) {
                heredoc = undefined;
            }
            continue;
        }
        const start = line.match(/<<\s*'?([A-Za-z_]+)'?\s*(\||\)|$|>|\s)/);
        if (start && !line.includes("<<<")) {
            heredoc = start[1];
        } else if (line === "}") {
            inside = false;
        }
    }
    return out.join("\n");
}

export interface Run {
    status: number;
    stdout: string;
    stderr: string;
    work: string;
    read(name: string): string;
    exists(name: string): boolean;
}

export interface RunOptions {
    /** The variables the installer sets before its functions run (with `vars` over them). */
    defaults?: Record<string, string>;
    /** Stub files of FIXTURES to source after `stubs.sh`, in this order. */
    extraStubs?: string[];
    /** Files of FIXTURES to copy to `<work>/bin/` as executables (a fake `bao`). */
    binaries?: string[];
    /** Environment variables of the test process that must not reach the script (a developer's own credentials). `vars` still set them. */
    unsetEnv?: string[];
}

/** Written with LF endings whatever the checkout has: sh takes a CR as part of the command. */
function lf(name: string): string {
    return fs.readFileSync(path.join(FIXTURES, name), "utf8").replace(/\r\n/g, "\n");
}

/** Sources the installer's functions with the stubs and these variables, then runs `body`; `setup` may add files to the work directory first. */
export function runInstaller(installer: string, body: string, vars: Record<string, string> = {}, setup?: (work: string) => void, options: RunOptions = {}): Run {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "installer-"));
    setup?.(work);
    fs.mkdirSync(path.join(work, "bin"), { recursive: true });
    for (const binary of options.binaries ?? []) {
        fs.writeFileSync(path.join(work, "bin", binary), lf(binary), { mode: 0o755 });
    }
    fs.writeFileSync(path.join(work, "stubs.sh"), lf("stubs.sh"));
    const extra = options.extraStubs ?? [];
    for (const stub of extra) {
        fs.writeFileSync(path.join(work, stub), lf(stub));
    }
    fs.writeFileSync(path.join(work, "functions.sh"), functionsOf(INSTALLERS[installer]));
    const assignments = Object.entries({ ...(options.defaults ?? {}), ...vars })
        .map(([key, value]) => `${key}='${value.replace(/'/g, "'\\''")}'`)
        .join("\n");
    const sources = ["stubs.sh", ...extra].map((name) => `source "$WORK/${name}"`).join("\n");
    const script = `export WORK='${work.replace(/\\/g, "/")}'\n${sources}\nsource "$WORK/functions.sh"\n${assignments}\n${body}\n`;
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const name of options.unsetEnv ?? []) {
        delete env[name];
    }
    const res = spawnSync(BASH, ["-c", script], { encoding: "utf8", env: { ...env, ...vars } });
    const file = (name: string) => path.join(work, name);
    return {
        status: res.status ?? -1,
        stdout: res.stdout,
        stderr: res.stderr,
        work,
        read: (name) => (fs.existsSync(file(name)) ? fs.readFileSync(file(name), "utf8").replace(/\r\n/g, "\n") : ""),
        exists: (name) => fs.existsSync(file(name)),
    };
}
