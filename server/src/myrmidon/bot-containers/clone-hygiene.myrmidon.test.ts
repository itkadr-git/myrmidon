// myrmidon(1.6.2-BOT-DISK-C): clone hygiene in the bot draft-directory lifecycle —
// the report the bot image writes, the verdicts, and the sweep on a real
// directory tree. Everything here is placeholder data: fake keys and paths.

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  cloneHygieneSignals,
  containerPathProblem,
  decideCloneFate,
  dropCloneSignalsExcept,
  findRepos,
  ingestCloneReport,
  lifecycleNotEffective,
  noteCloneReportSeen,
  noteVolumeRoot,
  parseCloneReport,
  parseGitRefCheck,
  parseHardlinkCheck,
  resetCloneHygieneStateForTests,
  type CloneReportEntry,
} from "./clone-hygiene.js";
import { sweepAllBotVolumes, sweepBotVolume } from "./draft-lifecycle.js";

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
    idleSeconds: 7200,
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

describe("ingestCloneReport (the board only reads the in-container report)", () => {
  const now = Date.parse("2026-10-01T12:00:00Z");
  const reportOf = (repos: CloneReportEntry[]) =>
    JSON.stringify({ version: 1, inspectedAt: "2026-10-01T11:50:00.000Z", repos });
  beforeEach(() => resetCloneHygieneStateForTests());

  it("signals unpushed work idle past the TTL, and nothing for clean, busy or unreported clones", () => {
    const ttl = 3_600_000;
    expect(
      ingestCloneReport(
        "bot-a",
        reportOf([
          entry({ path: "/workspace/clean" }),
          entry({ path: "/workspace/unpushed", unpushedCommits: 2 }),
          entry({ path: "/workspace/busy", dirty: true, idleSeconds: 60 }),
          entry({ path: "/workspace/unknown", dirty: true, idleSeconds: null }),
        ]),
        ttl,
        now,
      ),
    ).toBe(true);
    expect(cloneHygieneSignals().map((s) => [s.botKey, s.path])).toEqual([["bot-a", "/workspace/unpushed"]]);
  });

  it("drops a signal once the work is pushed, and the signals of a bot that has no report any more", () => {
    ingestCloneReport("bot-a", reportOf([entry({ unpushedCommits: 1 })]), 1000, now);
    ingestCloneReport("bot-b", reportOf([entry({ dirty: true })]), 1000, now);
    expect(cloneHygieneSignals()).toHaveLength(2);
    ingestCloneReport("bot-a", reportOf([entry()]), 1000, now);
    expect(cloneHygieneSignals().map((s) => s.botKey)).toEqual(["bot-b"]);
    dropCloneSignalsExcept(new Set(["bot-a"]));
    expect(cloneHygieneSignals()).toEqual([]);
  });

  it("refuses a report it cannot use and leaves the signals alone", () => {
    ingestCloneReport("bot-a", reportOf([entry({ unpushedCommits: 1 })]), 1000, now);
    expect(ingestCloneReport("bot-a", "garbage", 1000, now)).toBe(false);
    expect(cloneHygieneSignals()).toHaveLength(1);
  });
});

describe("the board without a mount of the bot volumes", () => {
  beforeEach(() => resetCloneHygieneStateForTests());
  afterEach(() => {
    delete process.env.MYRMIDON_BOT_VOLUME_ROOT;
    vi.restoreAllMocks();
  });

  it("does not crash, warns once, and reports 'lifecycle not effective' until a bot delivers a report", async () => {
    process.env.MYRMIDON_BOT_VOLUME_ROOT = path.join(tmpdir(), "no-such-bot-volume-root-" + Date.now());
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const config = { enabled: true, idleTtlMs: 1000, defaultIdleTtlMs: 1000 };

    expect(lifecycleNotEffective()).toBeNull();
    await expect(sweepAllBotVolumes(config)).resolves.toBeUndefined();
    await expect(sweepAllBotVolumes(config)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
    expect(lifecycleNotEffective()).toBe(true);

    noteCloneReportSeen();
    expect(lifecycleNotEffective()).toBe(false);
  });

  it("is effective when the board does see the root", () => {
    noteVolumeRoot(true, () => undefined);
    expect(lifecycleNotEffective()).toBe(false);
  });
});

describe("the board-side sweep on a host that does see the volumes", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "clone-hygiene-test-"));
    resetCloneHygieneStateForTests();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it("finds repositories up to three levels down and leaves them to the in-container reaper", async () => {
    const clone = path.join(root, "bot-a", "workspace", "owner", "repo");
    await mkdir(path.join(clone, ".git"), { recursive: true });
    const plain = path.join(root, "bot-a", "workspace", "plain");
    await mkdir(plain, { recursive: true });
    expect(await findRepos(path.join(root, "bot-a", "workspace", "owner"))).toEqual([clone]);

    await new Promise((resolve) => setTimeout(resolve, 20));
    await sweepBotVolume(root, { enabled: true, idleTtlMs: 0, defaultIdleTtlMs: 0 });
    expect(existsSync(clone)).toBe(true); // never reaped by mtime
    expect(existsSync(plain)).toBe(false); // the plain idle rule still applies
  });
});

// myrmidon(BOT-DISK-D): the container-start hard-link self-check rides the clone-hygiene
// report and becomes an attention signal per failing clone root.
describe("hard-link self-check in the clone report", () => {
  const now = Date.parse("2026-10-05T12:00:00Z");
  const reportWith = (hardlinkCheck: unknown) =>
    JSON.stringify({ version: 1, inspectedAt: "2026-10-05T11:59:00Z", repos: [], ...(hardlinkCheck === undefined ? {} : { hardlinkCheck }) });
  const failing = {
    store: "/workspace/.pnpm-store",
    importMethod: "hardlink",
    ok: false,
    roots: [
      { root: "/data/hermes", ok: true, error: null },
      { root: "/workspace", ok: false, error: "Invalid cross-device link" },
      { root: "/scratch", ok: false, error: "Invalid cross-device link" },
    ],
  };

  beforeEach(() => resetCloneHygieneStateForTests());

  it("parses the check and tolerates its absence or garbage", () => {
    expect(parseCloneReport(reportWith(undefined), now)?.hardlinkCheck).toBeNull();
    expect(parseCloneReport(reportWith("x"), now)?.hardlinkCheck).toBeNull();
    expect(parseHardlinkCheck({ store: 1, ok: true, roots: [] })).toBeNull();
    const parsed = parseCloneReport(reportWith(failing), now)?.hardlinkCheck;
    expect(parsed?.ok).toBe(false);
    expect(parsed?.roots).toHaveLength(3);
  });

  it("raises one signal per failing root, naming the store and the error, and none for a passing check", () => {
    expect(ingestCloneReport("bot-a", reportWith(failing), 3_600_000, now)).toBe(true);
    const signals = cloneHygieneSignals();
    expect(signals.map((signal) => signal.path).sort()).toEqual(["/scratch", "/workspace"]);
    for (const signal of signals) {
      expect(signal.kind).toBe("hardlink");
      expect(signal.reason).toContain("/workspace/.pnpm-store");
      expect(signal.reason).toContain("Invalid cross-device link");
    }
    // The next report, with the check passing (the bot restarted), clears them.
    const passing = { ...failing, ok: true, roots: failing.roots.map((root) => ({ ...root, ok: true, error: null })) };
    ingestCloneReport("bot-a", reportWith(passing), 3_600_000, now);
    expect(cloneHygieneSignals()).toEqual([]);
  });
});

// myrmidon(1.6.5 BOT-DISK-G): the container-start shared-git-objects self-check
// rides the same report and becomes an attention signal per failed check.
describe("shared-git-objects self-check in the clone report", () => {
  const now = Date.parse("2026-10-05T12:00:00Z");
  const reportWith = (gitRefCheck: unknown) =>
    JSON.stringify({ version: 1, inspectedAt: "2026-10-05T11:59:00Z", repos: [], ...(gitRefCheck === undefined ? {} : { gitRefCheck }) });
  const failing = {
    version: 1,
    ok: false,
    store: "/bot-scope/.git-objects",
    checks: [
      { check: "usr-local-shadow", ok: true, error: null },
      { check: "wrapper-runs", ok: false, error: "env: ‘node’: No such file or directory" },
      { check: "reference-clone", ok: false, error: "did not borrow the mirror's objects" },
    ],
  };

  beforeEach(() => resetCloneHygieneStateForTests());

  it("parses the check and tolerates its absence or garbage", () => {
    expect(parseCloneReport(reportWith(undefined), now)?.gitRefCheck).toBeNull();
    expect(parseCloneReport(reportWith("x"), now)?.gitRefCheck).toBeNull();
    expect(parseGitRefCheck({ store: "s", ok: "no", checks: [] })).toBeNull();
    expect(parseGitRefCheck({ ok: true })).toBeNull(); // checks must be an array
    const parsed = parseCloneReport(reportWith(failing), now)?.gitRefCheck;
    expect(parsed?.ok).toBe(false);
    expect(parsed?.store).toBe("/bot-scope/.git-objects");
    expect(parsed?.checks).toHaveLength(3);
    // A garbage item is dropped, a long field is truncated, not a crash.
    const ragged = parseGitRefCheck({ ok: false, store: "x".repeat(900), checks: [{ check: 1, ok: true }, { check: "c", ok: false, error: "e".repeat(900) }] });
    expect(ragged?.checks).toHaveLength(1);
    expect(ragged?.checks[0]?.error).toHaveLength(500);
    expect(ragged?.store).toHaveLength(500);
  });

  it("raises one signal per failing check, naming the store and the error, and none for a passing check", () => {
    expect(ingestCloneReport("bot-a", reportWith(failing), 3_600_000, now)).toBe(true);
    const signals = cloneHygieneSignals();
    expect(signals.map((signal) => signal.reason)).toEqual([
      "shared git objects check wrapper-runs failed: env: ‘node’: No such file or directory",
      "shared git objects check reference-clone failed: did not borrow the mirror's objects",
    ]);
    for (const signal of signals) {
      expect(signal.kind).toBe("gitref");
      expect(signal.path).toBe("/bot-scope/.git-objects");
    }
    // The next report, with the check passing (the bot restarted), clears them.
    const passing = { ...failing, ok: true, checks: failing.checks.map((c) => ({ ...c, ok: true, error: null })) };
    ingestCloneReport("bot-a", reportWith(passing), 3_600_000, now);
    expect(cloneHygieneSignals()).toEqual([]);
  });
});
