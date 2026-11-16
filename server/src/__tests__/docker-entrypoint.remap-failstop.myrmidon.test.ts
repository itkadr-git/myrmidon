import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const entrypoint = join(dirname(fileURLToPath(import.meta.url)), "../../../scripts/docker-entrypoint.sh");
const scratchDirs: string[] = [];
type Call = { command: string; args: string[] };
type Phase = "uid" | "group" | "membership";
type RunResult = { status: number | null; calls: Call[]; dir: string };

function scratch() {
  const dir = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir(), "remap-failstop-"));
  scratchDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function run(phase?: Phase, code = 0, mutate = false) {
  const dir = scratch();
  const trace = join(dir, "trace.jsonl");
  const helper = `#!${process.execPath}\n` + `
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const command = path.basename(process.argv[1]);
const args = process.argv.slice(2);
fs.appendFileSync(process.env.TRACE, JSON.stringify({ command, args }) + "\\n");
if (command === "id") {
  process.stdout.write(args.length === 1 ? "0\\n" : "1000\\n");
} else if ((command === "usermod" && args[0] === "-o" && process.env.FAIL_PHASE === "uid") ||
           (command === "groupmod" && process.env.FAIL_PHASE === "group") ||
           (command === "usermod" && args[0] === "-g" && process.env.FAIL_PHASE === "membership")) {
  process.exit(Number(process.env.FAIL_CODE));
} else if (command === "find") {
  process.stdout.write("mismatch\\n");
} else if (command === "gosu") {
  const child = spawnSync(args[1], args.slice(2), { env: process.env, stdio: "inherit" });
  process.exit(child.status === null ? 127 : child.status);
}
`;
  for (const name of ["id", "usermod", "groupmod", "find", "chown", "gosu", "payload"]) {
    writeFileSync(join(dir, name), helper, { mode: 0o755 });
  }
  let script = entrypoint;
  if (mutate) {
    script = join(dir, "mutated-entrypoint.sh");
    const original = readFileSync(entrypoint, "utf8");
    const mutated = original.replace("set -e\n", "set +e\n");
    if (mutated === original) throw new Error("Negative control mutation did not apply");
    writeFileSync(script, mutated);
  }
  const status = await new Promise<number | null>((resolve, reject) => {
    execFile("/bin/sh", [script, join(dir, "payload"), "argument with space"], {
      env: { PATH: dir, HOME: dir, TMPDIR: dir, TMP: dir, TEMP: dir, PAPERCLIP_HOME: dir,
        USER_UID: "1234", USER_GID: "2345", TRACE: trace, FAIL_PHASE: phase || "", FAIL_CODE: String(code) },
      timeout: 10000, killSignal: "SIGKILL",
    }, (error) => {
      if (error && (typeof error.code !== "number" || error.killed)) reject(error);
      else resolve(error ? error.code as number : 0);
    });
  });
  const calls = readFileSync(trace, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Call);
  return { status, calls, dir };
}

const root: Call = { command: "id", args: ["-u"] };
const uid: Call[] = [{ command: "id", args: ["-u", "node"] }, { command: "usermod", args: ["-o", "-u", "1234", "node"] }];
const group: Call[] = [{ command: "id", args: ["-g", "node"] }, { command: "groupmod", args: ["-o", "-g", "2345", "node"] }];
const membership: Call = { command: "usermod", args: ["-g", "2345", "node"] };

function expectFailure(result: RunResult, phase: Phase, code: number) {
  const expected = [root, ...uid];
  if (phase !== "uid") expected.push(...group);
  if (phase === "membership") expected.push(membership);
  expect(result.status).toBe(code);
  expect(result.calls).toEqual(expected);
}

describe("docker entrypoint remap fail-stop", () => {
  for (const phase of ["uid", "group", "membership"] as const) {
    for (const code of [1, 17, 42]) {
      it(`stops at ${phase} with status ${code}`, async () => {
        expectFailure(await run(phase, code), phase, code);
      });
    }
  }

  it("completes the remap before ownership repair and payload", async () => {
    const result = await run();
    expect(result.status).toBe(0);
    expect(result.calls).toEqual([
      root, ...uid, ...group, membership,
      { command: "find", args: [result.dir, "(", "!", "-user", "node", "-o", "!", "-group", "node", ")", "-print", "-quit"] },
      { command: "chown", args: ["-R", "node:node", result.dir] },
      { command: "gosu", args: ["node", join(result.dir, "payload"), "argument with space"] },
      { command: "payload", args: ["argument with space"] },
    ]);
  });

  it("detects a scratch copy with fail-stop disabled", async () => {
    const result = await run("uid", 17, true);
    expect(() => expectFailure(result, "uid", 17)).toThrow();
  });
});
