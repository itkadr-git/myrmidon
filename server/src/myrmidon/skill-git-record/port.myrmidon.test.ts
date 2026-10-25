// myrmidon(OPE-9408): regression tests for the git skill record port.
// These use a real throwaway git checkout in the test's tmp dir — the port's
// contract IS its filesystem/git behavior (escaping keys, serialization,
// timeouts), which fake ports cannot prove. Serialization and the timeout are
// proven through a PATH-level git wrapper that logs invocation windows.

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile, readFile, readdir, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createGitSkillRecordPort, GIT_SKILL_EXEC_TIMEOUT_MS } from "./port.js";

const run = promisify(execFile);
const REAL_GIT = "/usr/bin/git";

let repo: string;
let binDir: string;
let logFile: string;
let savedPath: string | undefined;

async function setup(opts: { wrapperSleepMs?: number; hangMs?: number } = {}) {
  repo = await mkdtemp(path.join(tmpdir(), "skill-git-record-"));
  await run(REAL_GIT, ["-C", repo, "init", "-q"]);
  await run(REAL_GIT, ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-q", "-m", "init"]);
  binDir = await mkdtemp(path.join(tmpdir(), "skill-git-bin-"));
  logFile = path.join(binDir, "git-calls.log");
  const hang = opts.hangMs ? `sleep ${opts.hangMs / 1000}` : "";
  await writeFile(
    path.join(binDir, "git"),
    `#!/bin/sh
echo "s $(date +%s%3N)" >> ${JSON.stringify(logFile)}
${hang}
${REAL_GIT} "$@"
rc=$?
echo "e $(date +%s%3N)" >> ${JSON.stringify(logFile)}
exit $rc
`,
    { mode: 0o755 },
  );
}

function wrapPath() {
  savedPath = process.env.PATH;
  process.env.PATH = `${binDir}:${process.env.PATH}`;
}

function restorePath() {
  if (savedPath !== undefined) {
    process.env.PATH = savedPath;
    savedPath = undefined;
  }
}

beforeEach(() => setup());

afterEach(() => {
  restorePath();
});

afterAll(async () => {
  for (const dir of [repo, binDir].filter(Boolean)) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

/** Overlap check on the wrapper log: git invocations must never interleave. */
async function assertNoOverlappingGitCalls() {
  const log = await readFile(logFile, "utf8");
  let depth = 0;
  for (const line of log.trim().split("\n").filter(Boolean)) {
    if (line.startsWith("s ")) depth += 1;
    else if (line.startsWith("e ")) depth -= 1;
    else throw new Error(`unexpected log line: ${line}`);
    expect(depth, `git calls overlapped:\n${log}`).toBeLessThanOrEqual(1);
  }
  expect(depth).toBe(0);
}

describe("myrmidon(OPE-9408): recordVerified key validation", () => {
  it.each(["../x", "..", "a/../b", "./x", "", "/abs", "team/../../escape"])(
    "rejects the escaping key %j before touching the checkout",
    async (key) => {
      wrapPath();
      const port = createGitSkillRecordPort({ repository: repo });
      await expect(
        port.recordVerified({ key, files: [{ path: "SKILL.md", content: "body" }], revisionNumber: 1 }),
      ).rejects.toThrow(/Invalid git skill key|A git skill entry/);
      restorePath();
      // Nothing was written into the checkout: no skills/ tree, clean status.
      expect(await readdir(path.join(repo, "skills")).catch(() => null)).toBeNull();
      const status = await run(REAL_GIT, ["-C", repo, "status", "--porcelain"]);
      expect(status.stdout).toBe("");
    },
  );

  it("still accepts a well-formed nested key", async () => {
    const port = createGitSkillRecordPort({ repository: repo });
    await port.recordVerified({ key: "team/example-skill", files: [{ path: "SKILL.md", content: "body" }], revisionNumber: 1 });
    expect(await readFile(path.join(repo, "skills", "team", "example-skill", "SKILL.md"), "utf8")).toBe("body");
  });
});

describe("myrmidon(OPE-9408): repository-wide serialization", () => {
  it("serializes concurrent recordVerified/listEntries across separate port instances", async () => {
    await setup({ wrapperSleepMs: 60 });
    // Two instances over one physical checkout — exactly the production wiring
    // (app.ts webhook routes + the skill-lifecycle service each create a port).
    const portA = createGitSkillRecordPort({ repository: repo });
    const portB = createGitSkillRecordPort({ repository: repo });
    wrapPath();
    await Promise.all([
      portA.recordVerified({ key: "team/one", files: [{ path: "SKILL.md", content: "one" }], revisionNumber: 1 }),
      portB.recordVerified({ key: "team/two", files: [{ path: "SKILL.md", content: "two" }], revisionNumber: 1 }),
      portA.listEntries(),
      portB.listEntries(),
    ]);
    restorePath();
    await assertNoOverlappingGitCalls();
    // Both records landed as atomic snapshots and the tree is clean.
    const entries = await portA.listEntries();
    expect(new Set(entries.map((e) => e.key))).toEqual(new Set(["team/one", "team/two"]));
    const status = await run(REAL_GIT, ["-C", repo, "status", "--porcelain"]);
    expect(status.stdout).toBe("");
  });

  it("releases the lock after an error: the next call runs and succeeds", async () => {
    await setup({ wrapperSleepMs: 40 });
    const port = createGitSkillRecordPort({ repository: repo });
    wrapPath();
    // Invalid file path fails INSIDE the critical section, after the key check.
    await expect(
      port.recordVerified({ key: "team/bad", files: [{ path: "../escape.md", content: "x" }], revisionNumber: 1 }),
    ).rejects.toThrow();
    // The mutex must not stay held by that failure.
    await port.recordVerified({ key: "team/good", files: [{ path: "SKILL.md", content: "ok" }], revisionNumber: 1 });
    restorePath();
    const entries = await port.listEntries();
    expect(entries.map((e) => e.key)).toEqual(["team/good"]);
    await assertNoOverlappingGitCalls();
  });
});

describe("myrmidon(OPE-9408): git exec timeout", () => {
  it("bounds a hung git invocation, fails the caller, and leaves no partial skill", { timeout: 15_000 }, async () => {
    expect(GIT_SKILL_EXEC_TIMEOUT_MS).toBeGreaterThan(0);
    // A git that never returns: the execFile timeout must fail the call
    // instead of pinning the per-repository lock forever. The rm+write ran
    // before the hung `add`, so the port's catch must restore the tree.
    await setup({ hangMs: 60_000 });
    const port = createGitSkillRecordPort({ repository: repo, execTimeoutMs: 400 });
    wrapPath();
    const startedAt = Date.now();
    await expect(port.recordVerified({ key: "team/hang", files: [{ path: "SKILL.md", content: "x" }], revisionNumber: 1 })).rejects.toThrow();
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    restorePath();
    // The lock was released: the next call completes against real git, and the
    // port's catch restored the tree, so the hung attempt left nothing.
    await port.recordVerified({ key: "team/after", files: [{ path: "SKILL.md", content: "ok" }], revisionNumber: 1 });
    const entries = await port.listEntries();
    expect(entries.map((e) => e.key)).toEqual(["team/after"]);
    const status = await run(REAL_GIT, ["-C", repo, "status", "--porcelain"]);
    expect(status.stdout).toBe("");
  });

  it("falls back to the default timeout when none is given", async () => {
    const port = createGitSkillRecordPort({ repository: repo });
    await port.recordVerified({ key: "team/default", files: [{ path: "SKILL.md", content: "ok" }], revisionNumber: 1 });
    expect((await port.listEntries()).map((e) => e.key)).toEqual(["team/default"]);
  });
});
