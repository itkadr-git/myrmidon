// myrmidon(1.6.2-BOT-DISK-C): clone hygiene in the bot draft-directory lifecycle —
// the report the bot image writes, the verdicts, and the sweep on a real
// directory tree. Everything here is placeholder data: fake keys and paths.

import { existsSync } from "node:fs";
import { link, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  beginBotCloneHygiene,
  CLONE_HYGIENE_REPORT_PATH,
  cloneHygieneSignals,
  containerPathProblem,
  decideCloneFate,
  judgeGitClones,
  parseCloneReport,
  resetCloneHygieneStateForTests,
  treeQuietSince,
  type CloneReportEntry,
} from "./clone-hygiene.js";
import { sweepBotVolume } from "./draft-lifecycle.js";

const HOUR = 60 * 60 * 1000;

function entry(overrides: Partial<CloneReportEntry> = {}): CloneReportEntry {
  return {
    path: "/workspace/proj",
    dirty: false,
    inProgress: false,
    stashCount: 0,
    unpushedCommits: 0,
    hasRemote: true,
    linkedWorktrees: 0,
    referencedBy: 0,
    branch: "feature",
    mergedIntoDefault: true,
    error: null,
    ...overrides,
  };
}

describe("containerPathProblem", () => {
  it("accepts paths under /workspace and /scratch and nothing else", () => {
    expect(containerPathProblem("/workspace/proj")).toBeNull();
    expect(containerPathProblem("/scratch/a/b")).toBeNull();
    for (const bad of ["/data/hermes/x", "/workspace", "/workspace/", "/workspace/../etc", "/workspace/./x", "/workspace//x", "/workspace/a\\b", "workspace/x"]) {
      expect(containerPathProblem(bad), bad).not.toBeNull();
    }
  });
});

describe("parseCloneReport", () => {
  const now = Date.parse("2026-10-01T12:00:00Z");
  const report = (over: Record<string, unknown> = {}) =>
    JSON.stringify({ version: 1, inspectedAt: "2026-10-01T11:00:00.000Z", repos: [entry()], ...over });

  it("reads a good report", () => {
    const parsed = parseCloneReport(report(), now)!;
    expect(parsed.inspectedAtMs).toBe(Date.parse("2026-10-01T11:00:00.000Z"));
    expect(parsed.repos.get("/workspace/proj")?.branch).toBe("feature");
  });

  it("ignores a report that is not valid, from the future, or older than a day", () => {
    expect(parseCloneReport("not json", now)).toBeNull();
    expect(parseCloneReport(report({ version: 2 }), now)).toBeNull();
    expect(parseCloneReport(report({ repos: "x" }), now)).toBeNull();
    expect(parseCloneReport(report({ inspectedAt: "2026-10-01T13:00:00Z" }), now)).toBeNull();
    expect(parseCloneReport(report({ inspectedAt: "2026-09-29T11:00:00Z" }), now)).toBeNull();
  });

  it("drops entries with a forbidden path and marks a malformed entry as an inspection failure", () => {
    const parsed = parseCloneReport(
      report({ repos: [entry({ path: "/etc/passwd" }), { path: "/workspace/x", dirty: "no" }] }),
      now,
    )!;
    expect(parsed.repos.has("/etc/passwd")).toBe(false);
    expect(parsed.repos.get("/workspace/x")?.error).toBe("malformed report entry");
  });
});

describe("decideCloneFate", () => {
  it("removes a clean, fully pushed, quiet clone", () => {
    expect(decideCloneFate(entry(), true)).toEqual({ action: "remove" });
    expect(decideCloneFate(entry({ mergedIntoDefault: null, branch: null }), true)).toEqual({ action: "remove" });
  });

  it("signals unpushed work only when the clone is quiet", () => {
    for (const work of [{ dirty: true }, { inProgress: true }, { stashCount: 2 }, { unpushedCommits: 3 }, { unpushedCommits: 1, hasRemote: false }]) {
      expect(decideCloneFate(entry(work), true).action, JSON.stringify(work)).toBe("signal");
      expect(decideCloneFate(entry(work), false).action, JSON.stringify(work)).toBe("keep");
    }
    expect((decideCloneFate(entry({ unpushedCommits: 1, hasRemote: false }), true) as { reason: string }).reason).toContain("no remote configured");
  });

  it("keeps without a signal: no report, inspection error, active, worktree base, borrowed objects", () => {
    expect(decideCloneFate(undefined, true).action).toBe("keep");
    expect(decideCloneFate(entry({ error: "git status failed" }), true).action).toBe("keep");
    expect(decideCloneFate(entry(), false).action).toBe("keep");
    expect(decideCloneFate(entry({ linkedWorktrees: 1 }), true).action).toBe("keep");
    expect(decideCloneFate(entry({ referencedBy: 1 }), true).action).toBe("keep");
  });
});

describe("on a real tree", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "clone-hygiene-test-"));
    resetCloneHygieneStateForTests();
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** A bot volume with one clone `workspace/<name>` (a .git directory and a file). */
  async function makeClone(name: string, sub = "workspace") {
    const dir = path.join(root, "bot-a", sub, name);
    await mkdir(path.join(dir, ".git"), { recursive: true });
    await writeFile(path.join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
    await writeFile(path.join(dir, "file.txt"), "x\n");
    return dir;
  }

  async function writeReport(entries: CloneReportEntry[], inspectedAtMs: number) {
    const file = path.join(root, "bot-a", "hermes", CLONE_HYGIENE_REPORT_PATH);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ version: 1, inspectedAt: new Date(inspectedAtMs).toISOString(), repos: entries }));
  }

  const botPath = () => path.join(root, "bot-a");
  /** Two hours from now, so everything made in the test is older than the report and the TTL. */
  const later = () => Date.now() + 2 * HOUR;

  async function judge(name: string, nowMs: number, sub: "workspace" | "scratch" = "workspace") {
    const ctx = await beginBotCloneHygiene(botPath(), "bot-a", nowMs);
    const handled = await judgeGitClones(path.join(botPath(), sub, name), { idleTtlMs: 1000 }, { ...ctx, sub });
    ctx.finish();
    return handled;
  }

  it("removes a clean pushed clone that nothing touched since the report and for longer than the TTL", async () => {
    const dir = await makeClone("proj");
    const nowMs = later();
    await writeReport([entry()], nowMs - HOUR);
    expect(await judge("proj", nowMs)).toBe(true);
    expect(existsSync(dir)).toBe(false);
  });

  it("keeps a clone changed after the report, and a clone without one", async () => {
    const dir = await makeClone("proj");
    const nowMs = later();
    // The report is older than the files: their ctime is after it.
    await writeReport([entry()], Date.now() - HOUR);
    expect(await judge("proj", nowMs)).toBe(true);
    expect(existsSync(dir)).toBe(true);
    expect(cloneHygieneSignals()).toEqual([]);

    resetCloneHygieneStateForTests();
    await rm(path.join(botPath(), "hermes"), { recursive: true });
    expect(await judge("proj", nowMs)).toBe(true);
    expect(existsSync(dir)).toBe(true);
  });

  it("keeps unpushed work and raises one signal, which goes when the clone does", async () => {
    const dir = await makeClone("proj");
    const nowMs = later();
    await writeReport([entry({ unpushedCommits: 2 })], nowMs - HOUR);
    await judge("proj", nowMs);
    expect(existsSync(dir)).toBe(true);
    expect(cloneHygieneSignals()).toMatchObject([
      { botKey: "bot-a", path: "/workspace/proj", branch: "feature", reason: expect.stringContaining("2 commits on no remote") },
    ]);

    await rm(dir, { recursive: true });
    const ctx = await beginBotCloneHygiene(botPath(), "bot-a", nowMs);
    ctx.finish();
    expect(cloneHygieneSignals()).toEqual([]);
  });

  it("finds a repository one level down and judges each separately", async () => {
    const a = await makeClone("owner/a");
    const b = await makeClone("owner/b");
    const nowMs = later();
    await writeReport(
      [entry({ path: "/workspace/owner/a" }), entry({ path: "/workspace/owner/b", dirty: true })],
      nowMs - HOUR,
    );
    expect(await judge("owner", nowMs)).toBe(true);
    expect(existsSync(a)).toBe(false);
    expect(existsSync(b)).toBe(true);
    expect(cloneHygieneSignals().map((s) => s.path)).toEqual(["/workspace/owner/b"]);
  });

  it("returns false for a directory with no repository, so the plain idle rule applies", async () => {
    await mkdir(path.join(botPath(), "workspace", "plain"), { recursive: true });
    expect(await judge("plain", later())).toBe(false);
  });

  it("trusts the mtime, not the ctime, of a hard-linked file (another link bumps its ctime)", async () => {
    const dir = await makeClone("proj");
    const store = path.join(root, "store-file");
    const linked = path.join(dir, "linked.js");
    const single = path.join(dir, "single.js");
    await writeFile(store, "payload\n");
    await writeFile(single, "payload\n");
    await link(store, linked);
    const old = new Date(Date.now() - 3 * HOUR);
    await utimes(linked, old, old); // mtime old, ctime now (utimes itself changes it)
    await utimes(single, old, old);
    const cutoff = Date.now() - HOUR;
    expect(await treeQuietSince(linked, cutoff)).toBe(true);
    expect(await treeQuietSince(single, cutoff)).toBe(false);
    expect(await treeQuietSince(dir, Date.now() + HOUR)).toBe(true);
  });

  it("makes the sweep leave an idle git clone to the report and still reaps a plain directory", async () => {
    const clean = await makeClone("clean");
    const unknown = await makeClone("unknown");
    const plain = path.join(botPath(), "workspace", "plain");
    await mkdir(plain, { recursive: true });
    await writeFile(path.join(plain, "note.txt"), "x\n");
    const old = new Date(Date.now() - 48 * HOUR);
    for (const dir of [clean, unknown, plain]) await utimes(dir, old, old);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await writeReport([entry({ path: "/workspace/clean" })], Date.now());
    await new Promise((resolve) => setTimeout(resolve, 30));

    await sweepBotVolume(root, { enabled: true, idleTtlMs: 0, defaultIdleTtlMs: 0 });

    expect(existsSync(plain)).toBe(false); // plain rule: the mtime is far past the TTL
    expect(existsSync(unknown)).toBe(true); // an old mtime alone never reaps a clone
    expect(existsSync(clean)).toBe(false); // clean, pushed, quiet since the report
  });
});
