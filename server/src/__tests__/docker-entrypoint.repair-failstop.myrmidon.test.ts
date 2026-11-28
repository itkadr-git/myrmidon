import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const entrypoint = join(dirname(fileURLToPath(import.meta.url)), "../../../scripts/docker-entrypoint.sh");
let scratch = "";
type Call = { command: string; args: string[] };

afterEach(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = "";
});

function run(homeSuffix: string, mismatch: boolean, chownExit = 0) {
  const root = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir();
  scratch = mkdtempSync(join(root, "entrypoint-repair-"));
  const bin = join(scratch, "bin");
  const home = join(scratch, homeSuffix);
  const trace = join(scratch, "trace.jsonl");
  mkdirSync(bin);
  mkdirSync(home, { recursive: true });
  const stub = `#!${process.execPath}\n` + `
const fs = require('node:fs');
const cp = require('node:child_process');
const path = require('node:path');
const command = path.basename(process.argv[1]);
const args = process.argv.slice(2);
fs.appendFileSync(process.env.TRACE, JSON.stringify({ command, args }) + '\\n');
if (command === 'id') console.log(args[1] === 'node' ? '1000' : '0');
if (command === 'find' && process.env.MISMATCH === '1') console.log('mismatch');
if (command === 'chown') process.exit(Number(process.env.CHOWN_EXIT));
if (command === 'gosu') {
  const result = cp.spawnSync(args[1], args.slice(2), { stdio: 'inherit', env: process.env, timeout: 5000 });
  process.exit(result.status === null ? 125 : result.status);
}
`;
  for (const name of ["id", "usermod", "groupmod", "find", "chown", "gosu", "payload"]) {
    writeFileSync(join(bin, name), stub, { mode: 0o755 });
  }
  let status = 0;
  try {
    execFileSync("/bin/sh", [process.env.MYRMIDON_TEST_ENTRYPOINT || entrypoint, join(bin, "payload")], {
      env: {
        PATH: bin, HOME: scratch, TMPDIR: scratch, TMP: scratch, TEMP: scratch,
        PAPERCLIP_HOME: home, TRACE: trace, MISMATCH: mismatch ? "1" : "0", CHOWN_EXIT: String(chownExit),
      },
      encoding: "utf8", timeout: 10000, killSignal: "SIGKILL", stdio: "pipe",
    });
  } catch (error) {
    const failure = error as { status?: number | null; signal?: string | null };
    if (typeof failure.status !== "number" || failure.signal) throw error;
    status = failure.status;
  }
  const calls: Call[] = existsSync(trace) ? readFileSync(trace, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
  return { status, calls, home };
}

function repairCalls(calls: Call[]) {
  return calls.filter(({ command }) => ["find", "chown", "gosu", "payload", "usermod", "groupmod"].includes(command));
}

describe("entrypoint ownership repair fail-stop", () => {
  it.each(["home", "home with spaces", "literal *?[abc]", "literal $(touch INJECTION)", "nested/segment/home"]) (
    "repairs %s before dropping privileges", (suffix) => {
      const { status, calls, home } = run(suffix, true);
      expect(status).toBe(0);
      const relevant = repairCalls(calls);
      expect(relevant.map((call) => call.command)).toEqual(["find", "chown", "gosu", "payload"]);
      expect(relevant[0].args).toEqual([home, "(", "!", "-user", "node", "-o", "!", "-group", "node", ")", "-print", "-quit"]);
      expect(relevant[1].args).toEqual(["-R", "node:node", home]);
      expect(relevant[2].args[0]).toBe("node");
    },
  );

  it.each([1, 13, 42])("stops boot with chown status %i", (code) => {
    const { status, calls, home } = run("failure home", true, code);
    expect(status).toBe(code);
    const relevant = repairCalls(calls);
    expect(relevant.map((call) => call.command)).toEqual(["find", "chown"]);
    expect(relevant[1].args).toEqual(["-R", "node:node", home]);
  });

  it("does not chown a clean tree", () => {
    const { status, calls } = run("clean home", false);
    expect(status).toBe(0);
    expect(repairCalls(calls).map((call) => call.command)).toEqual(["find", "gosu", "payload"]);
  });
});
