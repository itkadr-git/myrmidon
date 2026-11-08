// server/src/myrmidon/lesson-distill/settings.ts
//
// myrmidon(1.7 KNOWLEDGE-2.0 L-4): the distiller's configuration. Env-first,
// like the K-5 distiller's effective behavior: the sweep is off until
// MYRMIDON_LESSON_DISTILL_ENABLED=1; everything else has a safe default. The
// stored `general.agentMemory` row supplies the memory service address/key
// when the environment does not (the same resolution the memory card and the
// K-5 pass apply).

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
  const enabled = (env.MYRMIDON_LESSON_DISTILL_ENABLED ?? "").trim() === "1";
  const period = positiveInt(env.MYRMIDON_LESSON_DISTILL_PERIOD_MINUTES, DEFAULT_LESSON_DISTILL_SETTINGS.periodMinutes);
  const windowHours = positiveInt(env.MYRMIDON_LESSON_DISTILL_WINDOW_HOURS, DEFAULT_LESSON_DISTILL_SETTINGS.windowHours);
  const threshold = positiveInt(
    env.MYRMIDON_LESSON_DISTILL_REPEAT_THRESHOLD,
    DEFAULT_LESSON_DISTILL_SETTINGS.repeatThreshold,
  );
  const baseUrl = (env.MYRMIDON_MEMORY_BASE_URL ?? stored.baseUrl ?? "").trim();
  const apiKey = env.MYRMIDON_MEMORY_API_KEY ?? stored.apiKey ?? null;
  return { enabled, periodMinutes: period, windowHours, repeatThreshold: threshold, memoryBaseUrl: baseUrl, memoryApiKey: apiKey };
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
