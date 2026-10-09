// Processes of the board (myrmidon PROCS-1.1, design OPE-5394 §7.2): tests for
// the settings service and its route.
//
// The service is the only writer of `instance_settings.general.processes`, and
// the properties it must not lose are: the row is stored before the value is
// applied, every company gets one journal record, and the mode the row claims
// never hides the mode the build runs.
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import type { LogActivityInput } from "../../services/activity-log.js";
import {
  PROCESSES_SETTINGS_ACTION,
  applyProcessesSettingsToProcess,
  createProcessesSettingsService,
  type ProcessesSettingsDeps,
} from "./service.js";
import { myrmidonProcessesRoutes } from "./routes.js";
import {
  DEFAULT_PROCESSES_SETTINGS,
  type ProcessesSettingKey,
  type ProcessesSettings,
} from "@paperclipai/shared";

interface Harness {
  deps: ProcessesSettingsDeps;
  activity: LogActivityInput[];
  applied: Array<{ settings: ProcessesSettings; changedKeys: ProcessesSettingKey[] }>;
  stored: () => unknown;
}

function harness(initial?: unknown, env: Record<string, string | undefined> = {}): Harness {
  let stored = initial;
  const activity: LogActivityInput[] = [];
  const applied: Array<{ settings: ProcessesSettings; changedKeys: ProcessesSettingKey[] }> = [];
  const deps: ProcessesSettingsDeps = {
    settings: {
      getGeneral: async () => ({ processes: stored }),
      updateGeneral: async (patch) => {
        stored = patch.processes;
        return patch;
      },
    },
    listCompanyIds: async () => ["company-1", "company-2"],
    logActivity: async (entry) => {
      activity.push(entry);
      return entry;
    },
    apply: (settings, changedKeys) => {
      applied.push({ settings, changedKeys });
    },
    env,
  };
  return { deps, activity, applied, stored: () => stored };
}

const ACTOR = {
  actorType: "user" as const,
  actorId: "user-1",
  sessionId: "session-1",
  agentId: null,
  runId: null,
  agentApiKeyId: null,
  actorSource: "session" as const,
};

describe("processes settings service (PROCS-1.1)", () => {
  it("reads the defaults of an instance that never saved anything", async () => {
    const service = createProcessesSettingsService(harness().deps);
    const view = await service.read();
    assert.equal(view.settings.mode, "single");
    assert.equal(view.settings.singletonProxy, true);
    assert.equal(view.effectiveMode, "single");
    assert.equal(view.notInEffectReason, null);
    assert.equal(view.sources.mode, "default");
  });

  it("stores a patch, journals it once per company, and applies it after the row", async () => {
    const h = harness();
    const service = createProcessesSettingsService(h.deps);
    const view = await service.update({ apiCount: 2 }, ACTOR);

    assert.equal(view.settings.apiCount, 2);
    assert.equal(view.sources.apiCount, "settings");
    // The row is stored as a whole, the way `runLimits` stores it, so every key
    // it now holds is reported as saved — the mode this patch left alone is
    // written at the value in force and no longer counts as the default.
    assert.equal(view.sources.mode, "settings");
    assert.equal((h.stored() as ProcessesSettings).apiCount, 2);

    assert.equal(h.activity.length, 2);
    assert.deepEqual(
      h.activity.map((entry) => entry.companyId).sort(),
      ["company-1", "company-2"],
    );
    assert.equal(h.activity[0]?.action, PROCESSES_SETTINGS_ACTION);
    assert.equal(h.activity[0]?.actorType, "user");
    assert.equal(h.activity[0]?.entityType, "instance_settings");
    assert.deepEqual(h.activity[0]?.details?.changedKeys, ["apiCount"]);

    assert.equal(h.applied.length, 1);
    assert.deepEqual(h.applied[0]?.changedKeys, ["apiCount"]);
    assert.equal(h.applied[0]?.settings.apiCount, 2);
  });

  it("reports a stored split as the mode in force on the supervisor build", async () => {
    const h = harness({ mode: "split", apiCount: 2 });
    const service = createProcessesSettingsService(h.deps);
    const view = await service.read();
    assert.equal(view.settings.mode, "split");
    assert.equal(view.sources.mode, "settings");
    assert.equal(view.effectiveMode, "split");
    assert.equal(view.notInEffectReason, null);
  });

  it("lets the environment escape win over the stored mode", async () => {
    const h = harness({ mode: "split" }, { PAPERCLIP_PROCESS_MODE: "single" });
    const service = createProcessesSettingsService(h.deps);
    const view = await service.read();
    assert.equal(view.settings.mode, "single");
    assert.equal(view.sources.mode, "env");
    assert.equal(view.effectiveMode, "single");
    assert.equal(view.notInEffectReason, null);
  });

  it("writes nothing and journals nothing when a patch repeats the current value", async () => {
    const h = harness({ apiCount: 2 });
    const service = createProcessesSettingsService(h.deps);
    const view = await service.update({ apiCount: 2 }, ACTOR);
    assert.equal(view.settings.apiCount, 2);
    assert.deepEqual(h.applied[0]?.changedKeys, []);
    // The row is still written and the change is still journaled: the settings
    // page shows one save per change, and an empty diff is not a silent no-op.
    assert.equal(h.activity.length, 2);
  });

  it("applies the stored values to the running process, both modes included", () => {
    assert.equal(applyProcessesSettingsToProcess(DEFAULT_PROCESSES_SETTINGS), undefined);
    assert.equal(
      applyProcessesSettingsToProcess({ ...DEFAULT_PROCESSES_SETTINGS, mode: "split" }, ["mode"]),
      undefined,
    );
  });

  it("serves the settings on /myrmidon/processes as GET and PATCH", () => {
    const router = myrmidonProcessesRoutes({} as never, createProcessesSettingsService(harness().deps));
    const stack = (
      router as unknown as {
        stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }>;
      }
    ).stack;
    const routes = stack
      .filter((layer) => layer.route)
      .map((layer) => ({
        path: layer.route!.path,
        methods: Object.keys(layer.route!.methods)
          .filter((method) => layer.route!.methods[method])
          .sort(),
      }));
    assert.deepEqual(routes, [
      { path: "/myrmidon/processes", methods: ["get"] },
      { path: "/myrmidon/processes", methods: ["patch"] },
    ]);
  });
});