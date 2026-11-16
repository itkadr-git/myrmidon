import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const entrypoint = join(dirname(fileURLToPath(import.meta.url)), "../../../scripts/docker-entrypoint.sh");
type Call = { command: string; argv: string[] };
let scratch: string;
let bin: string;
let trace: string;

beforeEach(() => {
  scratch = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir(), "ownership-probe-"));
  bin = join(scratch, "bin");
  trace = join(scratch, "trace.jsonl");
  mkdirSync(bin);
  const stub = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const command = path.basename(process.argv[1]);
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.TRACE, JSON.stringify({ command, argv }) + '\\n');
if (command === 'id') process.stdout.write(argv.length === 1 ? '0\\n' : '1000\\n');
if (command === 'find') { process.stderr.write('probe diagnostic\\n'); process.stdout.write(process.env.PROBE_OUTPUT); }
if (command === 'gosu') { const child = cp.spawnSync(argv[1], argv.slice(2), { stdio: 'inherit', env: process.env }); process.exit(child.status === null ? 1 : child.status); }
`;
  for (const name of ["id", "usermod", "groupmod", "find", "chown", "gosu", "payload"]) {
    writeFileSync(join(bin, name), stub, { mode: 0o755 });
  }
});

afterEach(() => rmSync(scratch, { recursive: true, force: true }));

async function run(script: string, home: string | undefined, output: string) {
  const env: Record<string, string> = {
    PATH: bin, TRACE: trace, PROBE_OUTPUT: output,
    TMPDIR: scratch, TMP: scratch, TEMP: scratch,
  };
  if (home !== undefined) env.PAPERCLIP_HOME = home;
  const { stdout, stderr } = await promisify(execFile)("/bin/sh", [script, join(bin, "payload"), "argument with spaces"], {
    env, encoding: "utf8", timeout: 5000, killSignal: "SIGKILL", stdio: ["ignore", "pipe", "pipe"],
  });
  const calls = readFileSync(trace, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Call);
  expect(stderr).toBe("");
  return { stdout, calls };
}

function assertTrace(calls: Call[], home: string, isDirectory: boolean, mismatch: boolean) {
  const expected: Call[] = [
    { command: "id", argv: ["-u"] },
    { command: "id", argv: ["-u", "node"] },
    { command: "id", argv: ["-g", "node"] },
  ];
  if (isDirectory) expected.push({ command: "find", argv: [home, "(", "!", "-user", "node", "-o", "!", "-group", "node", ")", "-print", "-quit"] });
  if (isDirectory && mismatch) expected.push({ command: "chown", argv: ["-R", "node:node", home] });
  expected.push({ command: "gosu", argv: ["node", join(bin, "payload"), "argument with spaces"] });
  expected.push({ command: "payload", argv: ["argument with spaces"] });
  expect(calls).toEqual(expected);
}

describe("ownership probe", () => {
  it.each([
    ["missing home", "missing", "absent", "mismatch\n", false, false],
    ["file home", "file", "file", "mismatch\n", false, false],
    ["empty directory probe", "empty", "directory", "", true, false],
    ["newline-only output", "newline", "directory", "\n", true, false],
    ["mismatch output", "mismatch", "directory", "entry\n", true, true],
    ["spaces and parentheses", "home (with spaces)", "directory", "entry\n", true, true],
    ["multiple output lines", "multiple", "directory", "first\nsecond\n", true, true],
  ])("%s", async (_label, name, kind, output, directory, mismatch) => {
    const home = join(scratch, name);
    if (kind === "directory") mkdirSync(home);
    if (kind === "file") writeFileSync(home, "file");
    const result = await run(entrypoint, home, output);
    expect(result.stdout).toBe("");
    assertTrace(result.calls, home, directory, mismatch);
  });

  it.each([undefined, ""])("uses an isolated fixture fallback for PAPERCLIP_HOME=%s", async (configuredHome) => {
    const home = join(scratch, "fallback (fixture)");
    mkdirSync(home);
    const source = readFileSync(entrypoint, "utf8");
    const original = "${PAPERCLIP_HOME:-/paperclip}";
    expect(source.split(original)).toHaveLength(2);
    const fixture = join(scratch, "fallback-entrypoint.sh");
    writeFileSync(fixture, source.replace(original, `\${PAPERCLIP_HOME:-${home}}`));
    const result = await run(fixture, configuredHome, "entry\n");
    assertTrace(result.calls, home, true, true);
  });

  it("negative control detects removal of the first-match quit in a scratch copy", async () => {
    const home = join(scratch, "home");
    mkdirSync(home);
    const source = readFileSync(entrypoint, "utf8");
    expect(source.split("-print -quit")).toHaveLength(2);
    const mutant = join(scratch, "mutant.sh");
    writeFileSync(mutant, source.replace("-print -quit", "-print"));
    const result = await run(mutant, home, "entry\n");
    expect(() => assertTrace(result.calls, home, true, true)).toThrow();
  });
});
