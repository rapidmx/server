///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";
import * as uuid from "uuid";
import { RESTART_MESSAGE, superviseWorker, workerExecArgv } from "../../src/plugins/supervisor.js";

describe("workerExecArgv", () => {
    it("keeps loader flags and moves inspector flags to the next port", () => {
        expect(workerExecArgv(["--import", "tsx", "--inspect", "--inspect-brk=9300", "--inspect=127.0.0.1:9229", "--inspect-wait=0.0.0.0:1"])).toEqual([
            "--import",
            "tsx",
            "--inspect=9230",
            "--inspect-brk=9301",
            "--inspect=127.0.0.1:9230",
            "--inspect-wait=0.0.0.0:2",
        ]);
    });
});

describe("superviseWorker", () => {
    let dir: string;
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    beforeEach(() => {
        dir = path.join(process.cwd(), `tmp-supervisor-${uuid.v4()}`);
        fs.mkdirSync(dir);
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    /** A worker script that records each start (with its safe-mode flag) and then runs `behavior`. */
    function worker(behavior: string): URL {
        const file = path.join(dir, "worker.mjs");
        fs.writeFileSync(
            file,
            `import fs from "fs";
const log = ${JSON.stringify(path.join(dir, "starts.log"))};
fs.appendFileSync(log, (process.env.RAPIDMX_PLUGINS_SAFE_MODE === "1" ? "safe" : "normal") + "\\n");
const starts = fs.readFileSync(log, "utf8").trim().split("\\n").length;
${behavior}
`,
        );
        return pathToFileURL(file);
    }

    const starts = () => fs.readFileSync(path.join(dir, "starts.log"), "utf8").trim().split("\n");

    function run(url: URL, options: Record<string, any> = {}): Promise<number> {
        return new Promise((resolve) => superviseWorker(url, { logger, exit: resolve, ...options }));
    }

    it("starts the worker again when it asks to restart, then exits with its code", async () => {
        const code = await run(
            worker(`if (starts === 1) { process.send(${JSON.stringify(RESTART_MESSAGE)}, () => process.exit(0)); } else { process.exit(3); }`),
            { fastFailureMs: 0 },
        );
        expect(starts()).toEqual(["normal", "normal"]);
        expect(code).toBe(3);
    }, 30_000);

    it("starts without plugins after repeated failed starts", async () => {
        const code = await run(worker(`process.exit(process.env.RAPIDMX_PLUGINS_SAFE_MODE === "1" ? 0 : 1);`), { maxFastFailures: 2 });
        expect(starts()).toEqual(["normal", "normal", "safe"]);
        expect(code).toBe(0);
        expect(logger.error).toHaveBeenCalledWith(expect.stringMatching(/without plugins/));
    }, 30_000);

    it("exits with the worker's code when safe mode fails too", async () => {
        const code = await run(worker(`process.exit(4);`), { maxFastFailures: 1 });
        expect(starts()).toEqual(["normal", "safe"]);
        expect(code).toBe(4);
    }, 30_000);

    it("forwards a stop signal to the worker and exits when it does", async () => {
        const url = worker(`process.on("SIGTERM", () => process.exit(0)); process.send?.("ready"); setInterval(() => {}, 1000);`);
        const code = await new Promise<number>((resolve) => {
            const supervisor = superviseWorker(url, { logger, exit: resolve });
            const wait = setInterval(() => {
                if (fs.existsSync(path.join(dir, "starts.log"))) {
                    clearInterval(wait);
                    setTimeout(() => supervisor.stop("SIGTERM"), 200);
                }
            }, 20);
        });
        expect(code === 0 || code === 1).toBe(true);
        expect(starts()).toEqual(["normal"]);
    }, 30_000);
});
