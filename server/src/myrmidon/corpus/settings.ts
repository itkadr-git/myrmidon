// server/src/myrmidon/corpus/settings.ts
//
// myrmidon(1.6.6 CORPUS-2.0, part D): the module's switch as the tools read it.
//
// Part C owns the settings block — it writes `instance_settings.general.corpus`,
// validates it on save and audits the change; the settings screen (part E) edits
// it. This file is the other end of that contract: it turns whatever is found in
// the row into the three fields the tool surface acts on, and it does so without
// trusting the row.
//
// The rule is the same one the OCR settings follow, in the safe direction: a
// missing block means the module is off, and a value that is present but
// unusable (a top-k of zero, of `"7"`, of 10^9) falls back to the default — an
// operator typo in a limit must not switch the corpus on by itself, nor take the
// tools down with a value no search can honour.

import {
  DEFAULT_CORPUS_TOP_K,
  MAX_CORPUS_TOP_K,
  type CorpusModuleSettings,
} from "./contract.js";

/** The key of the block inside `instance_settings.general`. */
export const CORPUS_SETTINGS_KEY = "corpus";

function boundedInt(raw: unknown, fallback: number, min: number, max: number): number {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < min || raw > max) return fallback;
  return raw;
}

/**
 * The settings the tools act on, from the block part C stores. Anything that is
 * not a well-formed block reads as "off with the defaults" — fail closed, since
 * the fail-open direction would hand a bot tools for a module nobody enabled.
 */
export function readCorpusModuleSettings(raw: unknown): CorpusModuleSettings {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { enabled: false, defaultTopK: DEFAULT_CORPUS_TOP_K, maxTopK: MAX_CORPUS_TOP_K };
  }
  const block = raw as Record<string, unknown>;
  const maxTopK = boundedInt(block.maxTopK, MAX_CORPUS_TOP_K, 1, MAX_CORPUS_TOP_K);
  const defaultTopK = boundedInt(block.defaultTopK, Math.min(DEFAULT_CORPUS_TOP_K, maxTopK), 1, maxTopK);
  return { enabled: block.enabled === true, defaultTopK, maxTopK };
}