// myrmidon(OPE-12654): the rules of the decommission sweep (bot-decommission.ts). The wiring into
// the reconcile tick is covered in index.myrmidon.test.ts.

import { describe, expect, it, vi } from "vitest";
import { createBotKeyLock } from "./bot-key-lock.js";
import {
  BOT_DECOMMISSION_FAILED_EVENT,
  BOT_DECOMMISSION_HELD_EVENT,
  BOT_DECOMMISSION_INTERVAL_MS,
  BOT_DECOMMISSIONED_EVENT,
  cloneReportVerdict,
  createBotDecommissionSweepState,
  runBotDecommissionSweep,
  type BotDecommissionCandidate,
  type BotDecommissionSweepDeps,
} from "./bot-decommission.js";
import type { BotContainerDriver, BotContainerStatus } from "./driver.js";
import type { BotContainerActivitySink } from "./reconciler.js";

const clone = (overrides: Record<string, unknown> = {}) => ({
  path: "/workspace/repo",
  dirty: false,
  inProgress: false,
  stashCount: 0,
  unpushedCommits: 0,
  hasRemote: true,
  linkedWorktrees: 0,
  referencedBy: 0,
  idleSeconds: 60,
  branch: "main",
  mergedIntoDefault: true,
  error: null,
  ...overrides,
});

const report = (repos: Array<Record<string, unknown>>, inspectedAt = new Date()) =>
  JSON.stringify({ version: 1, inspectedAt: inspectedAt.toISOString(), repos });

describe("cloneReportVerdict", () => {
  it("is absent without a usable report", () => {
    for (const raw of [null, "", "not json", "null", "[]", JSON.stringify({ version: 2, inspectedAt: new Date().toISOString(), repos: [] })]) {
      expect(cloneReportVerdict(raw), String(raw)).toEqual({ kind: "absent" });
    }
  });

  it("is clean when every clone could go (a worktree base or a borrowed object store is not work)", () => {
    expect(cloneReportVerdict(report([]))).toEqual({ kind: "clean" });
    expect(cloneReportVerdict(report([clone(), clone({ path: "/scratch/base", linkedWorktrees: 2, referencedBy: 1 })]))).toEqual({ kind: "clean" });
  });

  it("names every clone with unpushed work or a failed inspection", () => {
    const verdict = cloneReportVerdict(
      report([
        clone(),
        clone({ path: "/workspace/dirty", dirty: true }),
        clone({ path: "/workspace/stash", stashCount: 1 }),
        clone({ path: "/workspace/rebase", inProgress: true }),
        clone({ path: "/workspace/local", unpushedCommits: 1, hasRemote: false }),
        clone({ path: "/workspace/broken", error: "git: not a repository" }),
        clone({ path: "/workspace/malformed", dirty: "yes" }),
      ]),
    );
    expect(verdict).toEqual({
      kind: "unpushed",
      reasons: [
        "/workspace/dirty: unpushed work: uncommitted changes",
        "/workspace/stash: unpushed work: 1 stash entry",
        "/workspace/rebase: unpushed work: a merge, rebase or cherry-pick in progress",
        "/workspace/local: unpushed work: 1 commit on no remote (no remote configured)",
        "/workspace/broken: inspection failed: git: not a repository",
        "/workspace/malformed: inspection failed: malformed report entry",
      ],
    });
  });

  it("an old report of unpushed work is still evidence: a stopped container cannot have pushed since", () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    expect(cloneReportVerdict(report([clone({ unpushedCommits: 3 })], threeDaysAgo))).toMatchObject({ kind: "unpushed" });
    expect(cloneReportVerdict(report([clone()], threeDaysAgo))).toEqual({ kind: "clean" });
  });
});

describe("runBotDecommissionSweep", () => {
  function sink() {
    const entries: Array<Parameters<BotContainerActivitySink["record"]>[0]> = [];
    return { entries, record: (entry: Parameters<BotContainerActivitySink["record"]>[0]) => void entries.push(entry) };
  }

  function driverOf(states: Record<string, BotContainerStatus["state"]>, reports: Record<string, string | null> = {}) {
    const calls: string[] = [];
    const removed: string[] = [];
    const driver: BotContainerDriver = {
      status: async (botKey) => {
        calls.push(`status:${botKey}`);
        return { botKey, state: removed.includes(botKey) ? "missing" : (states[botKey] ?? "missing") };
      },
      list: async () => [],
      templateDrift: async () => ({ drifted: false, fields: [] }),
      create: async () => {},
      recreate: async () => {},
      writeProfile: async () => {},
      start: async () => {},
      restart: async () => {},
      stop: async () => {},
      readCloneReport: async (botKey) => {
        calls.push(`report:${botKey}`);
        return reports[botKey] ?? null;
      },
      decommission: async (botKey) => {
        calls.push(`decommission:${botKey}`);
        removed.push(botKey);
      },
    };
    return { driver, calls, removed };
  }

  const candidate = (agentId: string, overrides: Partial<BotDecommissionCandidate> = {}): BotDecommissionCandidate => ({
    agentId,
    adapterType: "omp_local",
    status: "idle",
    ...overrides,
  });

  function sweepDeps(driver: BotContainerDriver, extra: Partial<BotDecommissionSweepDeps> = {}): BotDecommissionSweepDeps {
    return { driver, lock: createBotKeyLock(), listCandidates: async () => [], ...extra };
  }

  it("runs at most every interval, and a bot found gone is not asked again until it is reconciled again", async () => {
    let now = 1_000_000;
    const { driver, calls } = driverOf({});
    const listCandidates = vi.fn(async () => [candidate("agent-old")]);
    const deps = sweepDeps(driver, { listCandidates, now: () => now });
    const state = createBotDecommissionSweepState();

    await runBotDecommissionSweep([], deps, state);
    expect(listCandidates).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["status:agent-old"]); // missing: one status read, nothing else

    now += BOT_DECOMMISSION_INTERVAL_MS - 1;
    await runBotDecommissionSweep([], deps, state);
    expect(listCandidates).toHaveBeenCalledTimes(1);

    now += 1;
    await runBotDecommissionSweep([], deps, state);
    expect(listCandidates).toHaveBeenCalledTimes(2);
    expect(calls).toEqual(["status:agent-old"]); // remembered as gone

    // The agent came back to the runtime (and may leave it again): asked again next time.
    await runBotDecommissionSweep([{ agentId: "agent-old" }], deps, state);
    now += BOT_DECOMMISSION_INTERVAL_MS;
    await runBotDecommissionSweep([], deps, state);
    expect(calls).toEqual(["status:agent-old", "status:agent-old"]);
  });

  it("holds a running bot without a usable report and decommissions a stopped one", async () => {
    const { driver, calls } = driverOf({ "agent-live": "running", "agent-down": "stopped", "agent-sick": "unhealthy" });
    const activity = sink();
    const deps = sweepDeps(driver, {
      activity,
      listCandidates: async () => [candidate("agent-live"), candidate("agent-down", { status: "terminated", adapterType: "hermes_gateway" }), candidate("agent-sick")],
    });
    await runBotDecommissionSweep([], deps, createBotDecommissionSweepState());
    expect(calls.filter((call) => call.startsWith("decommission:"))).toEqual(["decommission:agent-down"]);
    expect(activity.entries.map((entry) => [entry.botKey, entry.level, entry.details?.event])).toEqual([
      ["agent-live", "error", BOT_DECOMMISSION_HELD_EVENT],
      ["agent-down", "info", BOT_DECOMMISSIONED_EVENT],
      ["agent-sick", "error", BOT_DECOMMISSION_HELD_EVENT],
    ]);
    expect(activity.entries[0]?.message).toBe("bot decommission held: the running container has no usable clone-hygiene report");
  });

  it("reports a held bot once per reason, not on every sweep", async () => {
    let now = 0;
    const reports: Record<string, string | null> = { "agent-dirty": report([clone({ dirty: true })]) };
    const { driver } = driverOf({ "agent-dirty": "running" }, reports);
    const activity = sink();
    const deps = sweepDeps(driver, { activity, listCandidates: async () => [candidate("agent-dirty")], now: () => now });
    const state = createBotDecommissionSweepState();
    for (let sweep = 0; sweep < 3; sweep++) {
      await runBotDecommissionSweep([], deps, state);
      now += BOT_DECOMMISSION_INTERVAL_MS;
    }
    expect(activity.entries).toHaveLength(1);
    // A different reason is news again.
    reports["agent-dirty"] = null;
    await runBotDecommissionSweep([], deps, state);
    expect(activity.entries.map((entry) => entry.message)).toEqual([
      "bot decommission held: a clone holds unpushed work",
      "bot decommission held: the running container has no usable clone-hygiene report",
    ]);
  });

  it("a failed decommission is reported and tried again on the next sweep; a failed listing fails only that sweep", async () => {
    let now = 0;
    const { driver } = driverOf({ "agent-x": "stopped" });
    let failures = 1;
    const decommission = vi.fn(async () => {
      if (failures-- > 0) throw new Error("dockergate: denied (state_precondition)");
    });
    driver.decommission = decommission;
    const activity = sink();
    let listFails = true;
    const deps = sweepDeps(driver, {
      activity,
      now: () => now,
      listCandidates: async () => {
        if (listFails) {
          listFails = false;
          throw new Error("database is down");
        }
        return [candidate("agent-x")];
      },
    });
    const state = createBotDecommissionSweepState();
    await expect(runBotDecommissionSweep([], deps, state)).resolves.toBeUndefined();
    now += BOT_DECOMMISSION_INTERVAL_MS;
    await runBotDecommissionSweep([], deps, state);
    now += BOT_DECOMMISSION_INTERVAL_MS;
    await runBotDecommissionSweep([], deps, state);
    expect(decommission).toHaveBeenCalledTimes(2);
    expect(activity.entries.map((entry) => entry.details?.event)).toEqual([
      BOT_DECOMMISSION_FAILED_EVENT,
      BOT_DECOMMISSION_FAILED_EVENT,
      BOT_DECOMMISSIONED_EVENT,
    ]);
    expect(activity.entries[1]?.details?.error).toBe("dockergate: denied (state_precondition)");
  });

  it("a run check that fails holds the bot; a running run holds it quietly", async () => {
    const { driver, calls } = driverOf({ "agent-a": "stopped", "agent-b": "stopped" });
    const activity = sink();
    const deps = sweepDeps(driver, {
      activity,
      listCandidates: async () => [candidate("agent-a"), candidate("agent-b")],
      hasRunningRun: async (agentId) => {
        if (agentId === "agent-a") throw new Error("query timed out");
        return true;
      },
    });
    await runBotDecommissionSweep([], deps, createBotDecommissionSweepState());
    expect(calls.some((call) => call.startsWith("decommission:"))).toBe(false);
    expect(activity.entries.map((entry) => [entry.botKey, entry.level, entry.details?.reason])).toEqual([
      ["agent-a", "error", "the agent's runs could not be checked"],
      ["agent-b", "info", "the agent has a running heartbeat run"],
    ]);
  });

  it("never throws, even when the activity sink does", async () => {
    const { driver } = driverOf({ "agent-a": "stopped" });
    const deps = sweepDeps(driver, {
      activity: {
        record: () => {
          throw new Error("sink is broken");
        },
      },
      listCandidates: async () => [candidate("agent-a")],
    });
    await expect(runBotDecommissionSweep([], deps, createBotDecommissionSweepState())).resolves.toBeUndefined();
  });

  it("stops between bots once the reconcile sweep is stopped", async () => {
    const { driver, calls } = driverOf({ "agent-a": "stopped", "agent-b": "stopped" });
    let stopped = false;
    const deps = sweepDeps(driver, {
      listCandidates: async () => [candidate("agent-a"), candidate("agent-b")],
      isStopped: () => stopped,
    });
    driver.decommission = async (botKey) => {
      calls.push(`decommission:${botKey}`);
      stopped = true;
    };
    await runBotDecommissionSweep([], deps, createBotDecommissionSweepState());
    expect(calls.filter((call) => call.startsWith("decommission:"))).toEqual(["decommission:agent-a"]);
  });
});
