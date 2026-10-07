// myrmidon(1.7-AUTO-UPDATE-B) update policy: the maintenance window and the
// fleet canary the deploy scheduler executes.
//
// Pins the two acceptance criteria of the ticket:
//   * a deploy that falls outside the maintenance window is POSTPONED until the
//     window opens (and nothing touches the host meanwhile);
//   * a canary batch that failed does NOT let the rest of the fleet follow.
//
// The pure halves (windowState / canaryPlan / canaryVerdict) are pinned here on
// their own as well, because the screen shows exactly those reasons.

import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import {
  canaryPlan,
  canaryVerdict,
  defaultAutoUpdateSettings,
  windowState,
  type AutoUpdateResolution,
  type AutoUpdateSettings,
  type AutoUpdateWindow,
} from "./auto-update.js";
import { emptyDeployJobDocument, newDeployJob, type DeployJob, type DeployJobDocument } from "./domain.js";
import { deployJobsService, type DeployJobServiceDeps, type FleetCanaryPort } from "./service.js";
import { readDeployJobsSettings } from "./settings.js";
import type { ProbeDeps } from "./registry.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const GOOD = `sha256:${"b".repeat(64)}`;
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const VERSION = "2026.916.1-myr.1";
const CI_LABELS = {
  "org.opencontainers.image.revision": COMMIT,
  "org.opencontainers.image.source": "https://github.com/itkadr-git/myrmidon",
  "org.opencontainers.image.version": VERSION,
};

/** `now` of the harness: 09:00Z, inside `ALL_DAYS` and outside `SHUT`. */
const NOW = "2026-10-07T09:00:00.000Z";

/** Opens every day 09:00–12:00 UTC: the deploy may start at NOW. */
const OPEN_DAY: AutoUpdateWindow = { days: [0, 1, 2, 3, 4, 5, 6], fromMinute: 9 * 60, toMinute: 12 * 60 };

/** The same window without the weekday of NOW: it opens tomorrow at 09:00Z. */
function shutWindow(): AutoUpdateWindow {
  const today = new Date(NOW).getUTCDay();
  return { ...OPEN_DAY, days: [0, 1, 2, 3, 4, 5, 6].filter((day) => day !== today) };
}

function policy(overrides: Partial<AutoUpdateSettings> = {}): AutoUpdateSettings {
  return { ...defaultAutoUpdateSettings(), ...overrides };
}

function probes(overrides: Partial<ProbeDeps> = {}): ProbeDeps {
  return {
    fetchJson: async (url: string) => {
      if (url.startsWith("https://registry-inspect.example.com/")) return { config: { Labels: CI_LABELS } };
      if (url.includes("/compare/")) return { status: "ahead" };
      if (url.includes("matching-refs")) return [];
      throw new Error(`unexpected url ${url}`);
    },
    registryInspectUrl: "https://registry-inspect.example.com/inspect",
    ...overrides,
  };
}

/** In-memory document store standing in for the instance_settings row. */
class MemoryStore {
  doc: DeployJobDocument = emptyDeployJobDocument();

  read = async () => structuredClone(this.doc);

  mutate = async <T>(change: (current: DeployJobDocument) => { next: DeployJobDocument | null; result: T }) => {
    const { next, result } = change(this.doc);
    if (next) this.doc = next;
    return { doc: this.doc, result, changed: next !== null };
  };
}

/** Put one job into the store in the state a test needs. */
function seed(store: MemoryStore, job: Partial<DeployJob>): DeployJob {
  const base = newDeployJob({
    id: "job-1",
    companyId: COMPANY_ID,
    digest: GOOD,
    reason: "deploy",
    startedBy: { actorType: "user", actorId: "user-a" },
    now: new Date(NOW),
  });
  const full: DeployJob = { ...base, ...job };
  store.doc = { ...emptyDeployJobDocument(), jobs: [full] };
  return full;
}

function harness(options: { policy?: AutoUpdateSettings; port?: FleetCanaryPort | null } = {}) {
  const store = new MemoryStore();
  const enter = vi.fn(async () => ({ id: "window-a", state: "entering" }));
  const exit = vi.fn(async () => ({ state: "off" }));
  const status = vi.fn(async () => ({ instance: { id: "window-a", state: "on" } }));
  let current: AutoUpdateSettings = options.policy ?? policy();

  const deps: DeployJobServiceDeps = {
    maintenance: {
      enter: enter as unknown as DeployJobServiceDeps["maintenance"]["enter"],
      exit: exit as unknown as DeployJobServiceDeps["maintenance"]["exit"],
      status: status as unknown as DeployJobServiceDeps["maintenance"]["status"],
    },
    readHostReport: async () => null,
    readHealth: async () => ({ version: VERSION, commit: COMMIT }),
    now: () => new Date(NOW),
    settings: { ...readDeployJobsSettings({}), enabled: true, tickMs: 60_000 },
    probes: probes(),
    logActivity: (async () => ({})) as unknown as DeployJobServiceDeps["logActivity"],
    autoUpdatePolicy: async (): Promise<AutoUpdateResolution> => ({
      settings: current,
      sources: { mode: "ui", window: "ui", canary: "ui" },
      overridden: [],
    }),
  };
  if (options.port !== null) deps.fleetCanary = options.port ?? fakePort().port;
  const service = deployJobsService(store as unknown as Db, deps);
  return {
    service,
    store,
    maintenance: { enter, exit, status },
    setPolicy(next: AutoUpdateSettings) {
      current = next;
    },
  };
}

function fakePort(verdict: "running" | "healthy" | "failed" = "running") {
  const startCanary = vi.fn(async () => undefined);
  const startRest = vi.fn(async () => undefined);
  const readVerdict = vi.fn(async () => ({ phase: verdict, detail: verdict === "failed" ? "bot-a did not come up" : null }));
  const port: FleetCanaryPort = {
    targets: async () => ["bot-a", "bot-b", "bot-c"],
    startCanary,
    startRest,
    verdict: readVerdict,
  };
  return { port, startCanary, startRest, verdict: readVerdict };
}

const ACTOR = { actorType: "user", actorId: "user-a" };

describe("auto-update: the maintenance window (B-1)", () => {
  it("has no window when no day is set: a deploy may start at any time", () => {
    const state = windowState({ days: [], fromMinute: 0, toMinute: 0 }, new Date(NOW));
    expect(state.configured).toBe(false);
    expect(state.open).toBe(true);
    expect(state.reason).toContain("no maintenance window set");
  });

  it("reports when a shut window opens next, and names the window", () => {
    const state = windowState(shutWindow(), new Date(NOW));
    expect(state.open).toBe(false);
    expect(state.opensAt).toBe("2026-10-08T09:00:00.000Z");
    expect(state.reason).toContain("outside the maintenance window");
  });

  it("is open inside the configured hours", () => {
    const state = windowState(OPEN_DAY, new Date(NOW));
    expect(state.open).toBe(true);
    expect(state.closesAt).toBe("2026-10-07T12:00:00.000Z");
  });

  it("postpones a verified deploy that falls outside the window instead of opening it", async () => {
    const h = harness({ policy: policy({ window: shutWindow() }) });
    const job = await h.service.create({ reference: GOOD }, ACTOR);

    expect(job.status).toBe("waiting_window");
    expect(job.windowOpensAt).toBe("2026-10-08T09:00:00.000Z");
    expect(h.maintenance.enter).not.toHaveBeenCalled();
    expect(job.steps[job.steps.length - 1]?.status).toBe("waiting_window");
    expect(job.steps[job.steps.length - 1]?.detail).toContain("outside the maintenance window");
    // The deploy is still ours (nothing else may start) and still cancellable.
    expect(job.active).toBe(true);
    expect(job.abortable).toBe(true);
  });

  it("resumes the postponed deploy when the window opens", async () => {
    const h = harness({ policy: policy({ window: shutWindow() }) });
    seed(h.store, { status: "waiting_window", windowOpensAt: "2026-10-08T09:00:00.000Z" });

    h.setPolicy(policy({ window: OPEN_DAY }));
    await h.service.tick();

    expect(h.maintenance.enter).toHaveBeenCalledTimes(1);
    expect((await h.service.current()).job?.status).not.toBe("waiting_window");
  });

  it("does not postpone anything when the window is open", async () => {
    const h = harness({ policy: policy({ window: OPEN_DAY }) });
    const job = await h.service.create({ reference: GOOD }, ACTOR);

    expect(job.status).not.toBe("waiting_window");
    expect(h.maintenance.enter).toHaveBeenCalled();
  });
});

describe("auto-update: the fleet canary (B-2)", () => {
  it("takes a share of the fleet first and keeps the rest waiting", () => {
    const plan = canaryPlan(["bot-a", "bot-b", "bot-c", "bot-d"], { ...defaultAutoUpdateSettings().canary, sharePercent: 25, minBots: 1, maxBots: 4 });
    expect(plan.canary).toEqual(["bot-a"]);
    expect(plan.rest).toEqual(["bot-b", "bot-c", "bot-d"]);
    expect(plan.reason).toContain("the rest follows only when it is healthy");
  });

  it("moves the fleet in one batch when the canary is off", () => {
    const plan = canaryPlan(["bot-a", "bot-b"], { ...defaultAutoUpdateSettings().canary, enabled: false });
    expect(plan.enabled).toBe(false);
    expect(plan.canary).toEqual([]);
    expect(plan.rest).toEqual(["bot-a", "bot-b"]);
  });

  it("a failed canary batch never lets the rest through", () => {
    const verdict = canaryVerdict({ phase: "failed", canary: ["bot-a"], rest: ["bot-b", "bot-c"], detail: "bot-a is unhealthy" });
    expect(verdict.proceed).toBe(false);
    expect(verdict.stopReason).toContain("bot-a is unhealthy");
    expect(verdict.stopReason).toContain("were NOT switched");
  });

  it("waits while the canary batch is still being watched", () => {
    const verdict = canaryVerdict({ phase: "running", canary: ["bot-a"], rest: ["bot-b"] });
    expect(verdict.proceed).toBe(false);
    expect(verdict.stopReason).toBeNull();
  });

  it("stops the rollout when the canary batch fails: the rest is not started", async () => {
    const fake = fakePort("failed");
    const h = harness({ policy: policy({ window: OPEN_DAY }), port: fake.port });
    seed(h.store, {
      status: "fleet_canary",
      canaryBatch: ["bot-a"],
      fleetRest: ["bot-b", "bot-c"],
      canaryStartedAt: "2026-10-07T08:50:00.000Z", // the settle time (300s) has passed
    });

    await h.service.tick();

    const after = (await h.service.current()).job;
    expect(fake.verdict).toHaveBeenCalledTimes(1);
    expect(fake.startRest).not.toHaveBeenCalled();
    expect(after?.status).toBe("canary_failed");
    expect(after?.failureReason).toContain("were NOT switched");
    expect(h.maintenance.exit).toHaveBeenCalledWith("deploy canary failed");
  });

  it("lets the rest follow a healthy canary batch and finishes the update", async () => {
    const fake = fakePort("healthy");
    const h = harness({ policy: policy({ window: OPEN_DAY }), port: fake.port });
    seed(h.store, {
      status: "fleet_canary",
      canaryBatch: ["bot-a"],
      fleetRest: ["bot-b", "bot-c"],
      canaryStartedAt: "2026-10-07T08:50:00.000Z",
    });

    await h.service.tick();

    expect(fake.startRest).toHaveBeenCalledTimes(1);
    expect(fake.startRest.mock.calls[0][0]).toMatchObject({ rest: ["bot-b", "bot-c"] });
    expect((await h.service.current()).job?.status).toBe("succeeded");
    expect(h.maintenance.exit).toHaveBeenCalledWith("deploy finished");
  });

  it("watches the canary batch for at least the settle time before asking for a verdict", async () => {
    const fake = fakePort("healthy");
    const h = harness({ policy: policy({ window: OPEN_DAY }), port: fake.port });
    seed(h.store, {
      status: "fleet_canary",
      canaryBatch: ["bot-a"],
      fleetRest: ["bot-b"],
      canaryStartedAt: "2026-10-07T08:59:00.000Z", // only 60s of the 300s settle time
    });

    await h.service.tick();

    expect(fake.verdict).not.toHaveBeenCalled();
    expect(fake.startRest).not.toHaveBeenCalled();
    expect((await h.service.current()).job?.status).toBe("fleet_canary");
  });

  it("records that there is no fleet to canary when the instance has no port", async () => {
    const h = harness({ policy: policy({ window: OPEN_DAY }), port: null });
    seed(h.store, { status: "fleet_canary", canaryBatch: ["bot-a"], fleetRest: ["bot-b"] });

    await h.service.tick();

    const after = (await h.service.current()).job;
    expect(after?.status).toBe("succeeded");
    expect(after?.steps[after.steps.length - 1]?.detail).toContain("no fleet canary on this instance");
  });
});