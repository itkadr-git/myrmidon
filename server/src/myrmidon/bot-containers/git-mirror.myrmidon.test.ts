// myrmidon(1.6.2-BOT-DISK-C): the board's bare git mirrors — layout, locking,
// refresh interval, atomic creation. git itself is replaced by a recorder.
// Everything here is placeholder data: fake owners, repositories and paths.

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  GIT_MIRROR_LOCK_STALE_MS,
  GIT_MIRROR_STAMP,
  gitMirrorEnv,
  gitMirrorPath,
  gitMirrorUrl,
  refreshGitMirrors,
  resetGitMirrorStateForTests,
  type GitMirrorDeps,
} from "./git-mirror.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "git-mirror-test-"));
  resetGitMirrorStateForTests();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function deps(overrides: Partial<GitMirrorDeps> & { now?: () => number } = {}) {
  const calls: string[][] = [];
  const log = { info: vi.fn(), warn: vi.fn() };
  const value: GitMirrorDeps = {
    runGit: async (args) => {
      calls.push(args);
      // `git init --bare <dir>` creates the directory the later commands use.
      if (args.includes("init")) await mkdir(args[args.length - 1]!, { recursive: true });
    },
    now: () => Date.now(),
    env: {},
    log,
    ...overrides,
  };
  return { value, calls, log };
}

const layout = (extra: Record<string, unknown> = {}) => ({
  sharedPackageCachePath: root,
  gitMirrorRepos: ["owner/repo"],
  gitMirrorRefreshMs: 60_000,
  ...extra,
});

describe("git mirror paths", () => {
  it("is <cache>/git/<owner>/<repo>.git in lower case, fetched over https", () => {
    expect(gitMirrorPath("/srv/cache", "Owner/Repo")).toBe("/srv/cache/git/owner/repo.git");
    expect(gitMirrorUrl("Owner/Repo")).toBe("https://github.com/owner/repo.git");
  });

  it("carries a token only in the environment, never in the arguments", () => {
    expect(gitMirrorEnv({})).toEqual({ args: [], env: { GIT_TERMINAL_PROMPT: "0" } });
    const withToken = gitMirrorEnv({ GITHUB_TOKEN: "fake-token-value" });
    expect(JSON.stringify(withToken.args)).not.toContain("fake-token-value");
    expect(withToken.env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(Object.values(withToken.env).some((v) => v.includes("fake-token-value"))).toBe(true);
  });
});

describe("refreshGitMirrors", () => {
  it("does nothing without a cache path or repositories", async () => {
    const { value, calls } = deps();
    expect(await refreshGitMirrors({ gitMirrorRepos: ["owner/repo"], gitMirrorRefreshMs: 60_000 }, value)).toEqual([]);
    expect(await refreshGitMirrors(layout({ gitMirrorRepos: [] }), value)).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("creates a new mirror in a temporary directory, stamps it and renames it into place", async () => {
    const { value, calls } = deps();
    const results = await refreshGitMirrors(layout(), value);
    expect(results).toEqual([{ repo: "owner/repo", outcome: "created" }]);
    const dir = gitMirrorPath(root, "owner/repo");
    expect(existsSync(path.join(dir, GIT_MIRROR_STAMP))).toBe(true);
    expect(existsSync(`${dir}.lock`)).toBe(false);
    const subcommands = calls.map((args) => args.find((a) => ["init", "config", "remote", "fetch", "gc"].includes(a)));
    expect(subcommands[0]).toBe("init");
    expect(subcommands).toContain("fetch");
    expect(subcommands[subcommands.length - 1]).toBe("gc");
    // The first init targets a temporary directory, not the final one.
    expect(calls[0]!.join(" ")).toContain(`${dir}.tmp-`);
    // Nothing in the mirror may ever be pruned: gc keeps unreachable objects.
    const gc = calls.find((args) => args.includes("gc"))!;
    expect(gc).toContain("gc.pruneExpire=never");
    expect(calls.some((args) => args.includes("--prune") && args.includes("fetch"))).toBe(true);
  });

  it("fetches an existing mirror once per interval", async () => {
    let now = 1_000_000_000_000;
    const { value, calls } = deps({ now: () => now });
    const dir = gitMirrorPath(root, "owner/repo");
    await mkdir(dir, { recursive: true });
    const stamp = path.join(dir, GIT_MIRROR_STAMP);
    await writeFile(stamp, "x\n");
    await utimes(stamp, new Date(now - 10 * 60_000), new Date(now - 10 * 60_000));

    expect(await refreshGitMirrors(layout(), value)).toEqual([{ repo: "owner/repo", outcome: "fetched" }]);
    expect(calls.some((args) => args.includes("init"))).toBe(false);
    const fetches = calls.filter((args) => args.includes("fetch")).length;
    expect(fetches).toBe(1);

    // The stamp is fresh now (real clock) and the process remembers the attempt.
    expect(await refreshGitMirrors(layout(), value)).toEqual([{ repo: "owner/repo", outcome: "not_due" }]);
    now += 61_000;
    await utimes(stamp, new Date(now - 120_000), new Date(now - 120_000));
    expect(await refreshGitMirrors(layout(), value)).toEqual([{ repo: "owner/repo", outcome: "fetched" }]);
  });

  it("stays out of a mirror a live refresh holds, and takes over a stale lock", async () => {
    const dir = gitMirrorPath(root, "owner/repo");
    const lock = `${dir}.lock`;
    await mkdir(lock, { recursive: true });
    const { value } = deps();
    expect(await refreshGitMirrors(layout(), value)).toEqual([{ repo: "owner/repo", outcome: "locked" }]);

    const old = new Date(Date.now() - GIT_MIRROR_LOCK_STALE_MS - 60_000);
    await utimes(lock, old, old);
    resetGitMirrorStateForTests();
    expect(await refreshGitMirrors(layout(), value)).toEqual([{ repo: "owner/repo", outcome: "created" }]);
    expect(existsSync(lock)).toBe(false);
  });

  it("reports a failed fetch, leaves no half-made mirror and releases the lock", async () => {
    const { value, log } = deps({
      runGit: async (args) => {
        if (args.includes("init")) await mkdir(args[args.length - 1]!, { recursive: true });
        if (args.includes("fetch")) throw new Error("git fetch failed: network down");
      },
    });
    const results = await refreshGitMirrors(layout(), value);
    expect(results[0]?.outcome).toBe("failed");
    const dir = gitMirrorPath(root, "owner/repo");
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(`${dir}.lock`)).toBe(false);
    expect(await readdir(path.dirname(dir))).toEqual([]);
    expect(log.warn).toHaveBeenCalled();
    // A failing mirror waits a full interval before the next attempt.
    expect(await refreshGitMirrors(layout(), value)).toEqual([{ repo: "owner/repo", outcome: "not_due" }]);
  });

  it("makes the mirror parents world-readable for the read-only bot mount", async () => {
    const { value } = deps();
    await refreshGitMirrors(layout(), value);
    const mode = (await stat(path.join(root, "git", "owner"))).mode & 0o777;
    expect(mode & 0o055).toBe(0o055);
  });
});
