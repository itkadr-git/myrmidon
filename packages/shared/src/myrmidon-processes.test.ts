// Processes of the board (myrmidon PROCS-1.1, design OPE-5394 §7.2): the contract
// of `instance_settings.general.processes` — the defaults are today's behaviour,
// the enum values stay in step between the schema and the exported lists, and a
// stored `split` is never reported as if it were running.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_PROCESSES_SETTINGS,
  PROCESSES_ADMISSION_STORES,
  PROCESSES_LIVE_EVENT_BUSES,
  PROCESSES_MODES,
  PROCESSES_MODE_ENV,
  PROCESSES_SETTING_KEYS,
  PROCESSES_SPLIT_UNSUPPORTED_REASON,
  describeProcessesEffect,
  mergeProcessesSettings,
  parseProcessesModeEnv,
  processesSettingsPatchSchema,
  processesSettingsSchema,
  resolveProcessesSettings,
} from "./myrmidon-processes.js";

describe("processes settings contract (PROCS-1.1)", () => {
  it("defaults to the board as it runs today", () => {
    assert.deepEqual(DEFAULT_PROCESSES_SETTINGS, {
      mode: "single",
      apiCount: 1,
      leaderLeaseTtlSec: 30,
      liveEventsBus: "local",
      admissionStore: "memory",
      singletonProxy: true,
    });
  });

  it("keeps the schema enums and the exported value lists in step", () => {
    const options = (schema: { options: readonly string[] }) => [...schema.options];
    const shape = processesSettingsSchema.shape as unknown as Record<string, { options: readonly string[] }>;
    assert.deepEqual(options(shape.mode), [...PROCESSES_MODES]);
    assert.deepEqual(options(shape.liveEventsBus), [...PROCESSES_LIVE_EVENT_BUSES]);
    assert.deepEqual(options(shape.admissionStore), [...PROCESSES_ADMISSION_STORES]);
  });

  it("names every setting key once", () => {
    assert.deepEqual([...PROCESSES_SETTING_KEYS].sort(), Object.keys(DEFAULT_PROCESSES_SETTINGS).sort());
  });

  it("resolves an empty row to the defaults, all of them sources 'default'", () => {
    const resolved = resolveProcessesSettings(undefined, {});
    assert.deepEqual(resolved.settings, DEFAULT_PROCESSES_SETTINGS);
    for (const key of PROCESSES_SETTING_KEYS) {
      assert.equal(resolved.sources[key], "default", `${key} must come from the default`);
    }
  });

  it("lets a saved row win over the default and marks it 'settings'", () => {
    const resolved = resolveProcessesSettings({ mode: "split", apiCount: 2 }, {});
    assert.equal(resolved.settings.mode, "split");
    assert.equal(resolved.settings.apiCount, 2);
    assert.equal(resolved.settings.singletonProxy, true);
    assert.equal(resolved.sources.mode, "settings");
    assert.equal(resolved.sources.apiCount, "settings");
    assert.equal(resolved.sources.singletonProxy, "default");
  });

  it("ignores a row it cannot parse instead of throwing", () => {
    const resolved = resolveProcessesSettings({ mode: "triple", apiCount: 99 }, {});
    assert.deepEqual(resolved.settings, DEFAULT_PROCESSES_SETTINGS);
  });

  it("lets PAPERCLIP_PROCESS_MODE win over the saved row and marks it 'env'", () => {
    const resolved = resolveProcessesSettings({ mode: "split" }, { [PROCESSES_MODE_ENV]: "single" });
    assert.equal(resolved.settings.mode, "single");
    assert.equal(resolved.sources.mode, "env");
  });

  it("ignores an unreadable escape", () => {
    assert.equal(parseProcessesModeEnv("all"), null);
    assert.equal(parseProcessesModeEnv(""), null);
    assert.equal(parseProcessesModeEnv(undefined), null);
    assert.equal(parseProcessesModeEnv(" SPLIT "), "split");
    const resolved = resolveProcessesSettings({ mode: "single" }, { [PROCESSES_MODE_ENV]: "all" });
    assert.equal(resolved.settings.mode, "single");
    assert.equal(resolved.sources.mode, "settings");
  });

  it("merges a patch into the current settings and leaves the rest alone", () => {
    const next = mergeProcessesSettings(DEFAULT_PROCESSES_SETTINGS, { apiCount: 3 });
    assert.equal(next.apiCount, 3);
    assert.equal(next.mode, "single");
    assert.equal(next.leaderLeaseTtlSec, 30);
  });

  it("rejects unknown keys and out-of-range values in a patch", () => {
    assert.equal(processesSettingsPatchSchema.safeParse({ apiCount: 2 }).success, true);
    assert.equal(processesSettingsPatchSchema.safeParse({ apiCount: 0 }).success, false);
    assert.equal(processesSettingsPatchSchema.safeParse({ apiCount: 5 }).success, false);
    assert.equal(processesSettingsPatchSchema.safeParse({ apiCount: 2.5 }).success, false);
    assert.equal(processesSettingsPatchSchema.safeParse({ mode: "all" }).success, false);
    assert.equal(processesSettingsPatchSchema.safeParse({ workerCount: 2 }).success, false);
  });

  it("reports a stored split as stored but not in effect", () => {
    const single = describeProcessesEffect(DEFAULT_PROCESSES_SETTINGS);
    assert.equal(single.effectiveMode, "single");
    assert.equal(single.notInEffectReason, null);

    const split = describeProcessesEffect({ ...DEFAULT_PROCESSES_SETTINGS, mode: "split" });
    assert.equal(split.effectiveMode, "single");
    assert.equal(split.notInEffectReason, PROCESSES_SPLIT_UNSUPPORTED_REASON);
  });
});