import { afterEach, describe, expect, it } from "vitest";
import { execFile, type ExecFileException } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const entrypoint = join(dirname(fileURLToPath(import.meta.url)), "../../../scripts/docker-entrypoint.sh");
const args = ["space here", "", "*.txt", "$(touch never)", `single' and "double"`, "\u043f\u0440\u0438\u0432\u0435\u0442"];
const directories: string[] = [];

afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Case = { uid: number; gid: number; status: number };

type RunResult = { status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; calls: { name: string; args: string[] }[] };

async function run(test: Case, mutate = false): Promise<RunResult> {
  const dir = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir(), "entrypoint-"));
  directories.push(dir);
  const trace = join(dir, "trace");
  const logger = join(dir, "stub.cjs");
  writeFileSync(logger, `const fs = require('node:fs');
const [name, ...args] = process.argv.slice(2);
fs.appendFileSync(process.env.TRACE, JSON.stringify({ name, args }) + '\\n');
if (name !== 'id') process.exit(99);
if (args.length !== 1 || !['-u', '-g'].includes(args[0])) process.exit(98);
process.stdout.write(args[0] === '-u' ? process.env.TEST_UID : process.env.TEST_GID);
`);
  for (const name of ["id", "usermod", "groupmod", "find", "chown", "gosu"]) {
    writeFileSync(join(dir, name), `#!/bin/sh\nexec "${process.execPath}" "${logger}" ${name} "$@"\n`, { mode: 0o755 });
  }
  const payload = join(dir, "payload.cjs");
  writeFileSync(payload, "process.stdout.write(JSON.stringify(process.argv.slice(2))); process.exit(Number(process.env.TEST_STATUS));\n");
  let script = entrypoint;
  if (mutate) {
    script = join(dir, "mutant.sh");
    const original = readFileSync(entrypoint, "utf8");
    const mutated = original.replace('    exec "$@"', '    exec $@');
    if (mutated === original) throw new Error("negative control mutation did not apply");
    writeFileSync(script, mutated);
  }
  const result = await new Promise<Omit<RunResult, "calls">>((resolve, reject) => {
    execFile("/bin/sh", [script, process.execPath, payload, ...args], {
      encoding: "utf8", timeout: 5000, killSignal: "SIGKILL",
      env: {
        PATH: dir, HOME: dir, TMPDIR: dir, TMP: dir, TEMP: dir,
        USER_UID: "1000", USER_GID: "1000", TEST_UID: String(test.uid),
        TEST_GID: String(test.gid), TEST_STATUS: String(test.status), TRACE: trace,
      },
    }, (error: ExecFileException | null, stdout, stderr) => {
      if (error && typeof error.code !== "number") return reject(error);
      resolve({ status: error ? error.code as number : 0, signal: error?.signal ?? null, stdout, stderr });
    });
  });
  const calls = existsSync(trace) ? readFileSync(trace, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
  return { ...result, calls };
}

function check(test: Case, actual: RunResult) {
  const mismatch = test.uid !== 1000 || test.gid !== 1000;
  const idArgs = [["-u"], ["-u"], ...(test.uid === 1000 ? [["-g"]] : []), ...(mismatch ? [["-u"], ["-g"]] : [])];
  expect(actual.calls).toEqual(idArgs.map((idArgs) => ({ name: "id", args: idArgs })));
  expect(actual.status).toBe(test.status);
  expect(actual.signal).toBeNull();
  expect(actual.stdout).toBe(JSON.stringify(args));
  expect(actual.stderr).toBe(mismatch
    ? `docker-entrypoint.sh: running unprivileged as ${test.uid}:${test.gid}; cannot remap to requested 1000:1000\n`
    : "");
}

describe("docker entrypoint non-root exec", () => {
  const cases: Case[] = [
    { uid: 1000, gid: 1000, status: 0 }, { uid: 1000, gid: 1000, status: 7 },
    { uid: 1001, gid: 1000, status: 42 }, { uid: 1001, gid: 1000, status: 0 },
    { uid: 1000, gid: 1001, status: 7 }, { uid: 1000, gid: 1001, status: 42 },
    { uid: 1001, gid: 1001, status: 0 }, { uid: 1001, gid: 1001, status: 42 },
  ];
  it.each(cases)("preserves argv and status for uid=$uid gid=$gid exit=$status", async (test) => {
    check(test, await run(test));
  });
  it("detects argument splitting in a scratch-copy negative control", async () => {
    const test = cases[0];
    const actual = await run(test, true);
    expect(() => expect(actual.stdout).toBe(JSON.stringify(args))).toThrow();
  });
});
