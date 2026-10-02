// server/src/myrmidon/tracing-health/settings.ts
//
// myrmidon(TRACING-HEALTH): settings for the "LLM tracing" health check.
//
// The check reads two live sources the board does not own: the Langfuse v4
// ClickHouse (its `events_core` table is where traces land since v4 — the old
// `traces`/`observations` tables are empty by design in `events_only` mode)
// and the LiteLLM gateway (its Prometheus `/metrics` endpoint counts callback
// logging failures). Like the other myrmidon integrations (M2-A, MEMORY-UI),
// addresses and key secret names are instance settings, not code: without
// both the Langfuse side and the gateway side the endpoint answers
// `enabled: false` instead of guessing, and the card says why.

export const LANGFUSE_CLICKHOUSE_URL_ENV = "MYRMIDON_TRACING_CLICKHOUSE_URL";
export const LANGFUSE_EVENTS_SECRET_ENV = "MYRMIDON_TRACING_CLICKHOUSE_KEY_SECRET";
export const LANGFUSE_EVENTS_PROJECT_ENV = "MYRMIDON_TRACING_LANGFUSE_PROJECT_ID";

export const LITELLM_METRICS_URL_ENV = "MYRMIDON_TRACING_LITELLM_METRICS_URL";
export const LITELLM_METRICS_SECRET_ENV = "MYRMIDON_TRACING_LITELLM_KEY_SECRET";

/** Incident 02.10: the check window is the delivery window the operator asked for. */
export const TRACING_WINDOW_MS_ENV = "MYRMIDON_TRACING_WINDOW_MS";
export const DEFAULT_TRACING_WINDOW_MS = 15 * 60 * 1000;

/** Callback failure lines tolerated in the window before the check goes red. */
export const TRACING_MAX_CALLBACK_FAILURES_ENV = "MYRMIDON_TRACING_MAX_CALLBACK_FAILURES";
export const DEFAULT_TRACING_MAX_CALLBACK_FAILURES = 5;

export interface TracingHealthSettings {
  enabled: boolean;
  /** ClickHouse HTTP interface of the Langfuse v4 instance, or null. */
  clickhouseUrl: string | null;
  /** Name of the company secret holding the ClickHouse auth header value. */
  clickhouseKeySecret: string | null;
  /** Langfuse project id to scope the `events_core` count to. */
  langfuseProjectId: string | null;
  /** LiteLLM `/metrics` URL, or null. */
  litellmMetricsUrl: string | null;
  /** Name of the company secret holding the gateway key for `/metrics`. */
  litellmKeySecret: string | null;
  windowMs: number;
  maxCallbackFailures: number;
}

/** Trimmed non-empty value, or null. */
function readNonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** An http(s) URL, or null when unset/invalid (a bad value reads as "off", never a crash). */
function readHttpUrlSetting(value: string | undefined): string | null {
  const trimmed = readNonEmpty(value);
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  } catch {
    return null;
  }
  return trimmed;
}

function readPositiveInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const raw = value?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

/**
 * The check needs both halves: Langfuse (where the traces should be) and the
 * gateway (which served the traffic and counts its own callback failures).
 * Either half alone cannot answer "is tracing healthy" — no traffic makes a
 * missing event meaningless, and no event sink makes the callback error rate
// unreachable — so `enabled` requires all four core values.
 */
export function readTracingHealthSettings(env: NodeJS.ProcessEnv = process.env): TracingHealthSettings {
  const clickhouseUrl = readHttpUrlSetting(env[LANGFUSE_CLICKHOUSE_URL_ENV]);
  const clickhouseKeySecret = readNonEmpty(env[LANGFUSE_EVENTS_SECRET_ENV]);
  const langfuseProjectId = readNonEmpty(env[LANGFUSE_EVENTS_PROJECT_ENV]);
  const litellmMetricsUrl = readHttpUrlSetting(env[LITELLM_METRICS_URL_ENV]);
  const litellmKeySecret = readNonEmpty(env[LITELLM_METRICS_SECRET_ENV]);
  return {
    enabled: Boolean(clickhouseUrl && clickhouseKeySecret && litellmMetricsUrl && litellmKeySecret),
    clickhouseUrl,
    clickhouseKeySecret,
    langfuseProjectId,
    litellmMetricsUrl,
    litellmKeySecret,
    windowMs: readPositiveInt(env[TRACING_WINDOW_MS_ENV], DEFAULT_TRACING_WINDOW_MS, 60_000, 6 * 3_600_000),
    maxCallbackFailures: readPositiveInt(
      env[TRACING_MAX_CALLBACK_FAILURES_ENV],
      DEFAULT_TRACING_MAX_CALLBACK_FAILURES,
      0,
      100_000,
    ),
  };
}
