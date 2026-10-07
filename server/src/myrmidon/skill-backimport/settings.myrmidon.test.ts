// server/src/myrmidon/skill-backimport/settings.myrmidon.test.ts
//
// myrmidon(1.6.5-SKILL-BACKIMPORT): the switch. The feature ships OFF and
// only an explicit on value enables it; the interval parses like its
// siblings (digits only, clamped to the documented range).

import { describe, expect, it } from "vitest";
import {
  DEFAULT_SKILL_BACKIMPORT_INTERVAL_SEC,
  MAX_SKILL_BACKIMPORT_INTERVAL_SEC,
  MIN_SKILL_BACKIMPORT_INTERVAL_SEC,
  readSkillBackImportSettings,
  SKILL_BACKIMPORT_ENABLED_ENV,
  SKILL_BACKIMPORT_INTERVAL_SEC_ENV,
} from "./settings.js";

describe("readSkillBackImportSettings", () => {
  it("is disabled when the env is unset (current behaviour)", () => {
    expect(readSkillBackImportSettings({}).enabled).toBe(false);
  });

  it("is disabled for anything but an explicit on value", () => {
    for (const value of ["0", "false", "off", "enabled", "2", ""]) {
      expect(readSkillBackImportSettings({ [SKILL_BACKIMPORT_ENABLED_ENV]: value }).enabled).toBe(false);
    }
  });

  it("is enabled for the explicit on spellings", () => {
    for (const value of ["1", "true", "yes", "on", "TRUE", " On "]) {
      expect(readSkillBackImportSettings({ [SKILL_BACKIMPORT_ENABLED_ENV]: value }).enabled).toBe(true);
    }
  });

  it("uses the default interval when unset", () => {
    expect(readSkillBackImportSettings({}).intervalMs).toBe(DEFAULT_SKILL_BACKIMPORT_INTERVAL_SEC * 1000);
  });

  it("parses a valid interval and rejects junk", () => {
    expect(readSkillBackImportSettings({ [SKILL_BACKIMPORT_INTERVAL_SEC_ENV]: "120" }).intervalMs).toBe(120_000);
    for (const value of ["abc", "-5", "1.5", ""]) {
      expect(readSkillBackImportSettings({ [SKILL_BACKIMPORT_INTERVAL_SEC_ENV]: value }).intervalMs).toBe(
        DEFAULT_SKILL_BACKIMPORT_INTERVAL_SEC * 1000,
      );
    }
  });

  it("falls back to the default outside the documented range", () => {
    expect(
      readSkillBackImportSettings({ [SKILL_BACKIMPORT_INTERVAL_SEC_ENV]: String(MIN_SKILL_BACKIMPORT_INTERVAL_SEC - 1) })
        .intervalMs,
    ).toBe(DEFAULT_SKILL_BACKIMPORT_INTERVAL_SEC * 1000);
    expect(
      readSkillBackImportSettings({ [SKILL_BACKIMPORT_INTERVAL_SEC_ENV]: String(MAX_SKILL_BACKIMPORT_INTERVAL_SEC + 1) })
        .intervalMs,
    ).toBe(DEFAULT_SKILL_BACKIMPORT_INTERVAL_SEC * 1000);
  });
});
