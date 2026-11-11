// server/src/myrmidon/lesson-distill/settings.ts
//
// myrmidon(1.7 KNOWLEDGE-2.0 L-4, OPE-12628): the distiller's configuration.
// Precedence per setting: explicit env -> saved UI value -> default. The
// stored `general.agentMemory` row supplies the memory service address/key
// when the environment does not (the same resolution the memory card and the
// K-5 pass apply).

import { liveBehaviorSetting, liveSavedSetting } from "../behavior-settings/live.js";

export interface LessonDistillSettings {
  enabled: boolean;
  /** Sweep period, minutes. */
  periodMinutes: number;
  /** Window length, hours (the issue fixes 24 h; overridable in tests). */
  windowHours: number;
  /** Repeats needed for `regulation_candidate`. */
  repeatThreshold: number;
  /** Memory service address (from env or the stored memory card settings). */
  memoryBaseUrl: string;
  /** Memory service key (from env or the stored memory card settings). */
  memoryApiKey: string | null;
}

export const DEFAULT_LESSON_DISTILL_SETTINGS: LessonDistillSettings = {
  enabled: false,
  periodMinutes: 60,
  windowHours: 24,
  repeatThreshold: 2,
  memoryBaseUrl: "",
  memoryApiKey: null,
};

interface MemoryCardLike {
  baseUrl?: unknown;
  apiKey?: unknown;
}

/** A stored `general.agentMemory` value, read leniently (K-5's cast pattern). */
export function readStoredMemoryCard(stored: unknown): { baseUrl: string; apiKey: string | null } {
  if (!stored || typeof stored !== "object") return { baseUrl: "", apiKey: null };
  const card = stored as MemoryCardLike;
  return {
    baseUrl: typeof card.baseUrl === "string" ? card.baseUrl : "",
    apiKey: typeof card.apiKey === "string" && card.apiKey.length > 0 ? card.apiKey : null,
  };
}

export function resolveLessonDistillSettings(
  env: Record<string, string | undefined> = process.env,
  storedMemoryCard?: unknown,
): LessonDistillSettings {
  const stored = readStoredMemoryCard(storedMemoryCard);

  // Precedence per setting: explicit env -> saved UI value -> default
  const enabled = resolveBooleanSetting(
    env.MYRMIDON_LESSON_DISTILL_ENABLED,
    liveSavedSetting<boolean>("lessonDistillEnabled"),
    DEFAULT_LESSON_DISTILL_SETTINGS.enabled,
  );
  const period = resolvePositiveIntSetting(
    env.MYRMIDON_LESSON_DISTILL_PERIOD_MINUTES,
    liveSavedSetting<number>("lessonDistillPeriodMinutes"),
    DEFAULT_LESSON_DISTILL_SETTINGS.periodMinutes,
  );
  const windowHours = resolvePositiveIntSetting(
    env.MYRMIDON_LESSON_DISTILL_WINDOW_HOURS,
    liveSavedSetting<number>("lessonDistillWindowHours"),
    DEFAULT_LESSON_DISTILL_SETTINGS.windowHours,
  );
  const threshold = resolvePositiveIntSetting(
    env.MYRMIDON_LESSON_DISTILL_REPEAT_THRESHOLD,
    liveSavedSetting<number>("lessonDistillRepeatThreshold"),
    DEFAULT_LESSON_DISTILL_SETTINGS.repeatThreshold,
  );

  const baseUrl = (env.MYRMIDON_MEMORY_BASE_URL ?? stored.baseUrl ?? "").trim();
  const apiKey = env.MYRMIDON_MEMORY_API_KEY ?? stored.apiKey ?? null;
  return { enabled, periodMinutes: period, windowHours, repeatThreshold: threshold, memoryBaseUrl: baseUrl, memoryApiKey: apiKey };
}

function parseExplicitBoolean(raw: string | undefined): boolean | null {
  if (raw === undefined || raw === "") return null;
  const normalized = raw.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  return null;
}

function resolveBooleanSetting(
  rawEnv: string | undefined,
  saved: boolean | undefined,
  fallback: boolean,
): boolean {
  const envParsed = parseExplicitBoolean(rawEnv);
  if (envParsed !== null) return envParsed;
  if (saved !== undefined) return saved;
  const live = liveBehaviorSetting<boolean>("lessonDistillEnabled");
  if (live !== undefined) return live;
  return fallback;
}

function resolvePositiveIntSetting(
  rawEnv: string | undefined,
  saved: number | undefined,
  fallback: number,
): number {
  if (rawEnv !== undefined && rawEnv.trim() !== "") {
    const parsed = Number.parseInt(rawEnv, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  if (typeof saved === "number" && Number.isFinite(saved) && saved > 0) return saved;
  return fallback;
}
