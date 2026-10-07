// server/src/myrmidon/debates/castes.ts
//
// myrmidon(1.7-DEBATE-ASYM-B): where a caste's debate override is stored, and
// how the stored value is turned into the configuration a run would use.
//
// The map lives inside the same `instance_settings.general.debate` value as the
// instance configuration, under `castes.<key>`:
//
//   general.debate = {
//     generator, critic, judge, rounds?, tokenCeiling?,   // part A, instance level
//     castes: { marketing: { companyId, enabled, ... } },  // part B, per caste
//   }
//
// No migration: the value already owns the engine configuration and its
// preserve key (A), it is read at run/PATCH time and never cached, and every
// caste entry is pinned to the company it was written for — castes are
// company-scoped rows, so a foreign entry is inert rather than silently
// driving a same-named caste elsewhere. A per-caste column on `agent_castes`
// would need a generated drizzle migration (SQL + journal + meta snapshot);
// that is deliberately not part of this part, and the change document says so.
//
// A write keeps every other key of the value and of the map: the instance
// configuration and the other castes survive a caste PATCH.

import {
  DEBATE_CASTES_KEY,
  pickCasteDebateOverride,
  readStoredCastes,
  resolveCasteDebateSettings,
  type CasteDebateOverride,
  type CasteDebatePatch,
  type CasteDebateResolution,
  type DebateSettings,
  type DebateSettingsResolution,
} from "@paperclipai/shared";
import { DEBATE_SETTINGS_KEY } from "./settings.js";

export interface CasteDebateStoreDeps {
  /** The instance-settings general bag (the row that holds `debate`). */
  getGeneral(): Promise<{ debate?: unknown }>;
  /** Merge a patch into the general bag (the instance-settings service). */
  updateGeneral(patch: Record<string, unknown>): Promise<unknown>;
}

export interface CasteDebateReadResult {
  /** The configuration a run of this caste would use, and its provenance. */
  resolution: CasteDebateResolution;
  /** The stored entry itself (for the editor); null when the caste inherits. */
  stored: CasteDebateOverride | null;
  /** A stored entry for this caste that belongs to another company (inert). */
  foreign: string | null;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** Read the stored debate value out of the general bag; a failed read is "nothing". */
async function readStoredDebate(deps: CasteDebateStoreDeps): Promise<unknown> {
  try {
    return (await deps.getGeneral())?.[DEBATE_SETTINGS_KEY];
  } catch {
    return undefined;
  }
}

/** One caste's resolution: its stored entry laid over the instance configuration. */
export async function readCasteDebate(
  deps: CasteDebateStoreDeps,
  input: { companyId: string; casteKey: string; instance: DebateSettingsResolution },
): Promise<CasteDebateReadResult> {
  const stored = await readStoredDebate(deps);
  const { map } = readStoredCastes(stored);
  const picked = pickCasteDebateOverride(map, { companyId: input.companyId, casteKey: input.casteKey });
  const resolution = resolveCasteDebateSettings({
    casteKey: input.casteKey.trim(),
    override: picked.override,
    instance: input.instance,
    entryProblem: picked.problem ?? picked.foreign,
  });
  return { resolution, stored: picked.override, foreign: picked.foreign };
}

/** The stored debate value as an object; a value that exists but is unusable is a refusal. */
function parseStoredObject(raw: unknown): { ok: true; value: unknown; body: Record<string, unknown> | null } | { ok: false; reason: string } {
  if (raw === undefined || raw === null || raw === "") return { ok: true, value: raw, body: null };
  let json: unknown = raw;
  if (typeof raw === "string") {
    try {
      json = JSON.parse(raw);
    } catch {
      return {
        ok: false,
        reason:
          "the stored debate configuration is not valid JSON — fix it on the instance settings page before saving a caste entry",
      };
    }
  }
  const body = asObject(json);
  if (body === null) {
    return {
      ok: false,
      reason:
        "the stored debate configuration is not an object — fix it on the instance settings page before saving a caste entry",
    };
  }
  return { ok: true, value: json, body };
}

/**
 * Write (or clear) one caste's entry. A null patch clears it — the caste goes
 * back to inheriting the instance configuration. Everything else in the stored
 * value is preserved verbatim; a stored value that exists but is not a JSON
 * object is refused rather than overwritten (the operator's explicit
 * configuration must not be dropped by a caste write).
 */
export async function writeCasteDebate(
  deps: CasteDebateStoreDeps,
  input: { companyId: string; casteKey: string; patch: CasteDebatePatch | null },
): Promise<void> {
  const parsed = parseStoredObject(await readStoredDebate(deps));
  if (!parsed.ok) throw new Error(parsed.reason);
  const body = parsed.body;
  const { map } = readStoredCastes(parsed.value);
  const key = input.casteKey.trim();
  const next: Record<string, unknown> = { ...map };
  if (input.patch === null) {
    delete next[key];
  } else {
    next[key] = { ...input.patch, companyId: input.companyId };
  }
  await deps.updateGeneral({ [DEBATE_SETTINGS_KEY]: valueAfterCasteWrite(body, next) });
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/**
 * The value to store for the **instance level** — a save or a clear — while
 * keeping part B's per-caste map: the two levels share one value, and clearing
 * the instance configuration from its screen must not silently delete a
 * caste's entry. With no map left, a null clears the whole value.
 */
export function withPreservedCastes(value: DebateSettings | null, stored: unknown): unknown {
  const body = typeof stored === "string" ? safeJson(stored) : stored;
  const { map } = readStoredCastes(body);
  const hasMap = Object.keys(map).length > 0;
  if (value === null) return hasMap ? { [DEBATE_CASTES_KEY]: map } : null;
  return hasMap ? { ...value, [DEBATE_CASTES_KEY]: map } : value;
}

/**
 * The stored value after a caste write: the instance level as it was, plus the
 * new map. When nothing is left at either level the whole value is cleared —
 * `{ castes: {} }` would be a valid but pointless row.
 */
function valueAfterCasteWrite(body: Record<string, unknown> | null, castes: Record<string, unknown>): unknown {
  const hasInstanceLevel = body !== null && body.generator !== undefined;
  if (!hasInstanceLevel && Object.keys(castes).length === 0) return null;
  return { ...(body ?? {}), [DEBATE_CASTES_KEY]: castes };
}