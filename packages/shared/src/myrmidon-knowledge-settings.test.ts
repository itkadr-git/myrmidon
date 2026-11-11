import { describe, expect, it } from "vitest";
import {
  KNOWLEDGE_AUTO_ACCEPT_MIN_CONFIDENCE_DEFAULT,
  KNOWLEDGE_MAX_ITEMS_DEFAULT,
  KNOWLEDGE_MAX_REVISION_BYTES_DEFAULT,
  KNOWLEDGE_SCHEDULE_DEFAULT,
  KNOWLEDGE_SETTINGS_ENV,
  applyKnowledgeSettingsPatch,
  knowledgeScheduleOk,
  knowledgeSettingsPatchErrors,
  parseKnowledgeBoundedInt,
  parseKnowledgeConfidence,
  preserveKnowledgeSettingsGeneralKey,
  readStoredKnowledgeSettings,
  resolveKnowledgeSettings,
  patchKnowledgeSettingsSchema,
  storedKnowledgeSettingsSchema,
} from "./myrmidon-knowledge-settings.js";

const EMPTY_ENV: NodeJS.ProcessEnv = {};

describe("myrmidon(1.7 KNOWLEDGE-2.0 L-11) knowledge settings resolution", () => {
  it("falls back to the defaults and badges them default", () => {
    const view = resolveKnowledgeSettings(undefined, EMPTY_ENV);
    expect(view.maxItems).toEqual({ value: KNOWLEDGE_MAX_ITEMS_DEFAULT, source: "default" });
    expect(view.maxRevisionBytes).toEqual({ value: KNOWLEDGE_MAX_REVISION_BYTES_DEFAULT, source: "default" });
    expect(view.autoAcceptEnabled).toEqual({ value: false, source: "default" });
    expect(view.autoAcceptMinConfidence).toEqual({
      value: KNOWLEDGE_AUTO_ACCEPT_MIN_CONFIDENCE_DEFAULT,
      source: "default",
    });
    expect(view.schedule).toEqual({ value: KNOWLEDGE_SCHEDULE_DEFAULT, source: "default" });
    expect(view.sectionReviewers).toEqual({ value: [], source: "default" });
  });

  it("prefers a saved value over the environment", () => {
    const view = resolveKnowledgeSettings(
      { maxItems: 10, autoAcceptEnabled: true },
      { [KNOWLEDGE_SETTINGS_ENV.maxItems]: "20", [KNOWLEDGE_SETTINGS_ENV.autoAcceptEnabled]: "false" },
    );
    expect(view.maxItems).toEqual({ value: 10, source: "ui" });
    expect(view.autoAcceptEnabled).toEqual({ value: true, source: "ui" });
  });

  it("uses the environment when nothing is saved and badges it env", () => {
    const view = resolveKnowledgeSettings(undefined, {
      [KNOWLEDGE_SETTINGS_ENV.maxItems]: "42",
      [KNOWLEDGE_SETTINGS_ENV.maxRevisionBytes]: "4096",
      [KNOWLEDGE_SETTINGS_ENV.autoAcceptEnabled]: "true",
      [KNOWLEDGE_SETTINGS_ENV.autoAcceptMinConfidence]: "0.5",
      [KNOWLEDGE_SETTINGS_ENV.schedule]: "*/15 * * * *",
    });
    expect(view.maxItems).toEqual({ value: 42, source: "env" });
    expect(view.maxRevisionBytes).toEqual({ value: 4096, source: "env" });
    expect(view.autoAcceptEnabled).toEqual({ value: true, source: "env" });
    expect(view.autoAcceptMinConfidence).toEqual({ value: "0.5", source: "env" });
    expect(view.schedule).toEqual({ value: "*/15 * * * *", source: "env" });
  });

  it("ignores an environment value outside the bounds and uses the default", () => {
    const view = resolveKnowledgeSettings(undefined, {
      [KNOWLEDGE_SETTINGS_ENV.maxItems]: "0",
      [KNOWLEDGE_SETTINGS_ENV.schedule]: "not a cron",
    });
    expect(view.maxItems.source).toBe("default");
    expect(view.schedule.source).toBe("default");
  });

  it("badges a saved reviewer list as ui and an empty one as default", () => {
    const saved = resolveKnowledgeSettings({
      sectionReviewers: [{ section: "runbooks", reviewerKind: "agent", reviewerId: "agent-1" }],
    }, EMPTY_ENV);
    expect(saved.sectionReviewers.source).toBe("ui");
    expect(saved.sectionReviewers.value).toEqual([
      { section: "runbooks", reviewerKind: "agent", reviewerId: "agent-1" },
    ]);
    expect(resolveKnowledgeSettings({ sectionReviewers: [] }, EMPTY_ENV).sectionReviewers.source).toBe("default");
  });

  it("rejects a patch field that is out of bounds and applies a valid one", () => {
    expect(knowledgeSettingsPatchErrors({ maxItems: "0" })).toEqual(["maxItems"]);
    expect(knowledgeSettingsPatchErrors({ schedule: "* * *" })).toEqual(["schedule"]);
    expect(knowledgeSettingsPatchErrors({ autoAcceptMinConfidence: "2" })).toEqual(["autoAcceptMinConfidence"]);
    expect(knowledgeSettingsPatchErrors({
      sectionReviewers: [{ section: "a", reviewerKind: "user" as const, reviewerId: "" }],
    })).toEqual(["sectionReviewers"]);

    const next = applyKnowledgeSettingsPatch({}, { maxItems: "15", autoAcceptEnabled: true, schedule: "0 * * * *" });
    expect(next).toEqual({ maxItems: 15, autoAcceptEnabled: true, schedule: "0 * * * *" });
  });

  it("keeps the stored key across a vendor rewrite and reads it back", () => {
    const preserved = preserveKnowledgeSettingsGeneralKey({ knowledge: { maxItems: 3 }, other: 1 });
    expect(preserved).toEqual({ knowledge: { maxItems: 3 } });
    expect(preserveKnowledgeSettingsGeneralKey({})).toEqual({});
    expect(preserveKnowledgeSettingsGeneralKey(null)).toEqual({});
    expect(readStoredKnowledgeSettings({ knowledge: { maxItems: 3, schedule: "0 * * * *" } })).toEqual({
      maxItems: 3,
      schedule: "0 * * * *",
    });
  });

  it("checks the small parsers directly", () => {
    expect(parseKnowledgeBoundedInt("10", 1, 20)).toBe(10);
    expect(parseKnowledgeBoundedInt("01", 1, 20)).toBeNull();
    expect(parseKnowledgeConfidence("0.90")).toBe("0.90");
    expect(parseKnowledgeConfidence("1.1")).toBeNull();
    expect(knowledgeScheduleOk("0 0 * * *")).toBe(true);
    expect(knowledgeScheduleOk("* * * *")).toBe(false);
  });

  it("rejects a patch that is out of bounds and accepts a well formed one", () => {
    expect(knowledgeSettingsPatchErrors({ maxItems: "0", schedule: "not cron" })).toEqual([
      "maxItems",
      "schedule",
    ]);
    expect(knowledgeSettingsPatchErrors({ maxItems: "10", schedule: "0 0 * * *" })).toEqual([]);
    const parsed = patchKnowledgeSettingsSchema.safeParse({ maxItems: "10", extra: true });
    expect(parsed.success).toBe(false);
    const stored = storedKnowledgeSettingsSchema.safeParse({ maxItems: "nope", anything: 1 });
    expect(stored.success).toBe(true);
  });
});
