// server/src/myrmidon/skill-backimport/settings.ts
//
// myrmidon(1.6.5-SKILL-BACKIMPORT): where the back-import sweep gets its
// switch and its period. See docs/myrmidon/SETTINGS.md.
//
// The feature is opt-in (ships OFF): it writes new rows into the company
// skill library with no human in the loop, so the board only does it when an
// operator turned it on. Only the exact on values (1/true/yes/on) enable it;
// a typo stays off — the fail-safe side is the current behaviour (no import).

export const SKILL_BACKIMPORT_ENABLED_ENV = "MYRMIDON_BOT_SKILL_BACKIMPORT";
export const SKILL_BACKIMPORT_INTERVAL_SEC_ENV = "MYRMIDON_BOT_SKILL_BACKIMPORT_INTERVAL_SEC";

/** Default cadence of the sweep; skills change on a human timescale, so a
 *  few minutes is enough and a pass is two gate reads per running bot. */
export const DEFAULT_SKILL_BACKIMPORT_INTERVAL_SEC = 300;
export const MIN_SKILL_BACKIMPORT_INTERVAL_SEC = 60;
export const MAX_SKILL_BACKIMPORT_INTERVAL_SEC = 86_400;

export interface SkillBackImportSettings {
  enabled: boolean;
  /** Minimum spacing between two passes. */
  intervalMs: number;
}

function readIntervalSec(env: NodeJS.ProcessEnv): number {
  const raw = env[SKILL_BACKIMPORT_INTERVAL_SEC_ENV]?.trim();
  if (!raw || !/^\d+$/.test(raw)) return DEFAULT_SKILL_BACKIMPORT_INTERVAL_SEC;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < MIN_SKILL_BACKIMPORT_INTERVAL_SEC || value > MAX_SKILL_BACKIMPORT_INTERVAL_SEC) {
    return DEFAULT_SKILL_BACKIMPORT_INTERVAL_SEC;
  }
  return value;
}

/** Read the effective settings. Opt-in semantics: unset or any value that is
 *  not an explicit on spelling disables the sweep. */
export function readSkillBackImportSettings(env: NodeJS.ProcessEnv = process.env): SkillBackImportSettings {
  const raw = env[SKILL_BACKIMPORT_ENABLED_ENV]?.trim().toLowerCase();
  const enabled = raw === "1" || raw === "true" || raw === "yes" || raw === "on";
  return { enabled, intervalMs: readIntervalSec(env) * 1000 };
}
