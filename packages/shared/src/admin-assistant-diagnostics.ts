import { z } from "zod";

// ─── Admin-assistant dry-run diagnostics DTO ────────────────────────────────
//
// The /admin-assistant/dry-run endpoint returns a probe bundle that is
// assembled at runtime from live database and filesystem state.  Probes
// are strictly read-only, but they can still surface credential-shaped
// values by accident (e.g. a detail object that happens to carry an
// api_key field).  This module defines the typed response contract and
// the sanitizer that strips secrets before the payload is serialized to
// JSON or written to logs.

// ─── Zod schemas ────────────────────────────────────────────────────────────

export const adminAssistantDryRunProbeStatusSchema = z.enum([
  "ok",
  "degraded",
]);

export const adminAssistantDryRunProbeResultSchema = z.object({
  name: z.string().min(1),
  status: adminAssistantDryRunProbeStatusSchema,
  durationMs: z.number().nonnegative(),
  detail: z.record(z.string(), z.unknown()).optional(),
  error: z.string().optional(),
});

export const adminAssistantDryRunSummarySchema = z.object({
  total: z.number().nonnegative(),
  ok: z.number().nonnegative(),
  degraded: z.number().nonnegative(),
});

export const adminAssistantDryRunDiagnosticsSchema = z.object({
  dry_run: z.literal(true),
  timestamp: z.string().min(1),
  probes: z.array(adminAssistantDryRunProbeResultSchema),
  summary: adminAssistantDryRunSummarySchema,
});

// ─── TypeScript types ───────────────────────────────────────────────────────

export type AdminAssistantDryRunProbeStatus = z.infer<
  typeof adminAssistantDryRunProbeStatusSchema
>;

export type AdminAssistantDryRunProbeResult = z.infer<
  typeof adminAssistantDryRunProbeResultSchema
>;

export type AdminAssistantDryRunSummary = z.infer<
  typeof adminAssistantDryRunSummarySchema
>;

export type AdminAssistantDryRunDiagnostics = z.infer<
  typeof adminAssistantDryRunDiagnosticsSchema
>;

// ─── Sanitizer ─────────────────────────────────────────────────────────────

/** Keys that must never appear in a dry-run diagnostics payload. */
const SECRET_KEY_PATTERN =
  /pass(word)?|secret|token|api[_-]?key|auth|credential|private|cert|session|cookie/i;

const REDACTED_PLACEHOLDER = "[REDACTED]";

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Recursively walk a probe-detail value and replace any secret-bearing
 * field with a fixed placeholder.  The walk is defensive: it tolerates
 * cycles via a depth cap and never throws.
 */
export function sanitizeDryRunDiagnosticsDetail(
  value: unknown,
  depth = 0,
): unknown {
  if (depth > 20) return REDACTED_PLACEHOLDER;

  if (Array.isArray(value)) {
    return value.map((entry) =>
      sanitizeDryRunDiagnosticsDetail(entry, depth + 1),
    );
  }

  if (!isPlainRecord(value)) {
    return value;
  }

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      out[key] = REDACTED_PLACEHOLDER;
    } else {
      out[key] = sanitizeDryRunDiagnosticsDetail(entry, depth + 1);
    }
  }
  return out;
}

/**
 * Apply sanitizeDryRunDiagnosticsDetail to every probe in a diagnostics
 * bundle.  Safe (non-secret) fields are preserved verbatim.
 */
export function sanitizeDryRunDiagnostics(
  diagnostics: AdminAssistantDryRunDiagnostics,
): AdminAssistantDryRunDiagnostics {
  return {
    ...diagnostics,
    probes: diagnostics.probes.map((probe) => ({
      ...probe,
      detail:
        probe.detail === undefined
          ? undefined
          : (sanitizeDryRunDiagnosticsDetail(probe.detail) as Record<
              string,
              unknown
            >),
    })),
  };
}

/**
 * Serialize diagnostics to a JSON-safe object.  Secrets are removed by
 * sanitizeDryRunDiagnostics before the result is returned, so the value
 * is safe to pass to JSON.stringify or loggers.
 */
export function toSafeDryRunDiagnosticsJson(
  diagnostics: AdminAssistantDryRunDiagnostics,
): AdminAssistantDryRunDiagnostics {
  return sanitizeDryRunDiagnostics(diagnostics);
}
