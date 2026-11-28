import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const entrypoint = join(dirname(fileURLToPath(import.meta.url)), "../../../scripts/docker-entrypoint.sh");
let scratch: string;

type Trace = { command: string; argv: string[]; cwd: string; pid: number };
type RunResult = { status: number | null; signal: NodeJS.Signals | null; pid: number | undefined; trace: Trace[] };

beforeEach(() => {
  scratch = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir(), "gosu-exec-"));
  const logger = join(scratch, "logger.cjs");
  writeFileSync(logger, `const fs = require('node:fs');
const [command, ...argv] = process.argv.slice(2);
fs.appendFileSync(process.env.TRACE, JSON.stringify({ command, argv, cwd: process.cwd(), pid: process.ppid }) + '\\n');
`);
  const stub = (name: string, body: string) => writeFileSync(join(scratch, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  stub("id", 'if [ "$1" = "-u" ] && [ "$2" != "node" ]; then echo 0; else echo 1000; fi');
  for (const name of ["usermod", "groupmod", "find", "chown"]) {
    stub(name, `"${process.execPath}" "${logger}" ${name} "$@"\nexit 99`);
  }
  stub("gosu", `"${process.execPath}" "${logger}" gosu "$@"
[ "$1" = node ] || exit 98
shift
[ -z "$GOSU_FAILURE" ] || exit "$GOSU_FAILURE"
exec "$@"`);
  stub("payload", `"${process.execPath}" "${logger}" payload "$@"
exit "$PAYLOAD_EXIT"`);
});

afterEach(() => rmSync(scratch, { recursive: true, force: true }));

async function run(script: string, args: string[], payloadExit: number, gosuFailure?: number) {
  const trace = join(scratch, "trace.jsonl");
  const payload = join(scratch, "payload");
  const env = {
    PATH: scratch, HOME: scratch, TMPDIR: scratch, TMP: scratch, TEMP: scratch,
    PAPERCLIP_HOME: join(scratch, "absent"), TRACE: trace,
    PAYLOAD_EXIT: String(payloadExit), GOSU_FAILURE: gosuFailure ? String(gosuFailure) : "",
  };
  return await new Promise<RunResult>((resolve, reject) => {
    const child = execFile("/bin/sh", [script, payload, ...args], { cwd: scratch, env, timeout: 5000, killSignal: "SIGKILL" }, (error) => {
      if (error && typeof error.code !== "number" && !error.signal) return reject(error);
      const records = readFileSync(trace, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Trace);
      resolve({ status: error ? (typeof error.code === "number" ? error.code : null) : 0, signal: error?.signal ?? null, pid: child.pid, trace: records });
    });
  });
}

function assertSuccess(result: RunResult, args: string[], status: number) {
  const payload = join(scratch, "payload");
  expect(result.signal).toBeNull();
  expect(result.status).toBe(status);
  expect(result.trace).toEqual([
    { command: "gosu", argv: ["node", payload, ...args], cwd: scratch, pid: result.pid },
    { command: "payload", argv: args, cwd: scratch, pid: result.pid },
  ]);
}

describe("root entrypoint gosu exec contract", () => {
  const cases: Array<[string, string[], number]> = [
    ["no arguments", [], 0],
    ["empty argument", [""], 0],
    ["whitespace", [" ", "a b", "\t"], 9],
    ["literal glob", ["*.js", "[ab]?"], 43],
    ["literal substitution", ["$(touch never)", "`echo never`"], 0],
    ["quotes", ["'single'", '"double"', "a\\b"], 9],
    ["mixed arguments", ["", "x y", "*", "$(id)", '"'], 43],
    ["newline", ["one\ntwo", "--", "-n"], 0],
  ];
  it.each(cases)("preserves %s and exit status", async (_name, args, status) => {
    assertSuccess(await run(entrypoint, args, status), args, status);
  });

  it.each([126, 127])("propagates gosu refusal %i without launching payload", async (status) => {
    const args = ["", "two words"];
    const result = await run(entrypoint, args, 0, status);
    expect(result.signal).toBeNull();
    expect(result.status).toBe(status);
    expect(result.trace).toEqual([{ command: "gosu", argv: ["node", join(scratch, "payload"), ...args], cwd: scratch, pid: result.pid }]);
  });

  it("detects argument loss in a mutated scratch copy", async () => {
    const original = readFileSync(entrypoint, "utf8");
    const mutated = original.replace('exec gosu node "$@"', 'exec gosu node "$1"');
    expect(mutated).not.toBe(original);
    const copy = join(scratch, "mutated-entrypoint.sh");
    writeFileSync(copy, mutated);
    const args = ["first", "second"];
    const result = await run(copy, args, 0);
    expect(() => assertSuccess(result, args, 0)).toThrow();
  });
});
