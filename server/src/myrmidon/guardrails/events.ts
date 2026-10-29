// server/src/myrmidon/guardrails/events.ts
//
// myrmidon(1.6-GRD): the guardrail event journal — the flag-only record of
// detector firings on run output. One row per event in `guardrail_events`
// plus an `activity_log` line; the snippet column only ever stores text in
// which every detected secret/PII fragment is replaced by a
// `[REDACTED:<subtype>]` placeholder (by shape, not by registered value) and
// that went through the existing secret masking (S5), so neither the journal
// nor the activity log can leak a credential value or personal data.
//
// The recordGuardrailEvent contract below is FROZEN for the sibling part B
// (prompt-injection detectors): same name, same shape, part B writes against
// it with a mock. Do not change either.
//
// The output hook (`run-output.ts`) is the only caller for part A; part B
// (input injection) and later parts reuse recordGuardrailEvent directly.

import { and, desc, eq, or } from "drizzle-orm";
import type { Db } from "@myrmidon/db";
import { guardrailEvents, heartbeatRuns } from "@myrmidon/db";
import { logActivity } from "../../services/activity-log.js";
import { maskSecretsInText } from "../secret-masking.js";
import {
  GUARDRAIL_CATEGORIES,
  detectGuardrailHits,
  guardrailSnippet,
  redactGuardrailHits,
  redactGuardrailText,
  summarizeGuardrailHits,
} from "./detect.js";

/** Hard limits: a snippet is short, a scan is bounded, a run journals few events. */
export const GUARDRAIL_SNIPPET_MAX_CHARS = 200;
export const GUARDRAIL_SCAN_MAX_CHARS = 262_144;
export const GUARDRAIL_MAX_EVENTS_PER_RUN = 20;

/** Where the detector ran. Part A reports run-output surfaces. */
export const GUARDRAIL_SURFACE_RUN_OUTPUT = "run_output";

export const GUARDRAILS_ACTOR_ID = "myrmidon-guardrails";

/** Env vars of the guardrail layer, read here and not in config.ts. */
export const GUARDRAILS_OUTPUT_ENABLED_ENV = "MYRMIDON_GUARDRAILS_OUTPUT_ENABLED";
export const GUARDRAILS_OUTPUT_CATEGORIES_ENV = "MYRMIDON_GUARDRAILS_OUTPUT_CATEGORIES";

export interface GuardrailOutputSettings {
  /** Master switch; off by default and turned on at rollout. */
  enabled: boolean;
  /** Which detector kinds run (csv from env, default every category). */
  categories: readonly ("secret" | "pii")[];
}

const ALL_CATEGORIES = ["secret", "pii"] as const;

/** Reads the module env; `1`/`true` enable (the ticket default is off). */
export function readGuardrailOutputSettings(env: NodeJS.ProcessEnv = process.env): GuardrailOutputSettings {
  const enabled = env[GUARDRAILS_OUTPUT_ENABLED_ENV] === "1" || env[GUARDRAILS_OUTPUT_ENABLED_ENV] === "true";
  const raw = (env[GUARDRAILS_OUTPUT_CATEGORIES_ENV] ?? "").trim();
  if (!raw) return { enabled, categories: ALL_CATEGORIES };
  const wanted = new Set(
    raw
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => (ALL_CATEGORIES as readonly string[]).includes(entry)),
  );
  // Unknown csv entries mean misconfiguration, not "detect nothing": fall
  // back to all categories rather than silently disabling a detector.
  if (wanted.size === 0) return { enabled, categories: ALL_CATEGORIES };
  return { enabled, categories: ALL_CATEGORIES.filter((kind) => wanted.has(kind)) };
}

/**
 * FROZEN public contract (part B depends on this exact shape).
 * `snippet` must already be masked by the caller when it comes from real
 * output; this module masks it once more so a caller mistake cannot store
 * a raw value.
 */
export interface RecordGuardrailEventInput {
  companyId: string;
  issueId: string | null;
  runId: string | null;
  kind: "secret" | "pii" | string;
  rule?: string | null;
  mode?: string | null;
  level?: string | null;
  agentId?: string | null;
  decision?: string | null;
  surface: string;
  severity: "info" | "warn" | "error" | string;
  snippet: string | null;
  occurredAt: Date;
}

/**
 * Shape-redact (all detectors), value-mask (S5) and clamp a snippet. Applied to
 * every snippet before it reaches guardrail_events or activity_log, whatever
 * the caller already did.
 */
export function sanitizeGuardrailSnippet(snippet: string | null | undefined): string | null {
  if (typeof snippet !== "string" || snippet.length === 0) return null;
  // Value masking first (URL credentials, registered secrets), then the shape
  // redaction of whatever is left.
  const masked = redactGuardrailText(maskSecretsInText(snippet.slice(0, GUARDRAIL_SCAN_MAX_CHARS))).trim();
  if (!masked) return null;
  return masked.length > GUARDRAIL_SNIPPET_MAX_CHARS ? `${masked.slice(0, GUARDRAIL_SNIPPET_MAX_CHARS - 1)}…` : masked;
}

/** Inserts one event row and one activity-log line. */
export async function recordGuardrailEvent(db: Db, input: RecordGuardrailEventInput): Promise<{ id: string }> {
  const maskedSnippet = sanitizeGuardrailSnippet(input.snippet);
  const rule = input.rule ?? input.kind;
  const decision = input.decision ?? input.mode ?? "flag";
  const [row] = await db
    .insert(guardrailEvents)
    .values({
      companyId: input.companyId,
      kind: input.kind,
      rule,
      mode: input.mode ?? null,
      level: input.level ?? null,
      agentId: input.agentId ?? null,
      decision,
      surface: input.surface,
      severity: input.severity,
      runId: input.runId,
      issueId: input.issueId,
      snippet: maskedSnippet,
      occurredAt: input.occurredAt,
    })
    .returning({ id: guardrailEvents.id });
  await logActivity(db, {
    companyId: input.companyId,
    actorType: "system",
    actorId: GUARDRAILS_ACTOR_ID,
    action: "guardrails.event_recorded",
    entityType: "guardrail_event",
    entityId: row.id,
    runId: input.runId,
    issueId: input.issueId,
    details: {
      kind: input.kind,
      rule,
      mode: input.mode ?? null,
      level: input.level ?? null,
      agentId: input.agentId ?? null,
      decision,
      surface: input.surface,
      severity: input.severity,
      snippet: maskedSnippet,
    },
  });
  return { id: row.id };
}

export interface GuardrailEventFilters {
  rule?: string;
  kind?: string;
  mode?: string;
  level?: string;
  agentId?: string;
  agent?: string;
  decision?: string;
  severity?: string;
  surface?: string;
  runId?: string;
  issueId?: string;
}

export interface ListGuardrailEventsOptions {
  limit?: number;
  offset?: number;
  filters?: GuardrailEventFilters;
}

/** Newest-first event list for the board route with filtering and pagination. */
export async function listGuardrailEvents(
  db: Db,
  companyId: string,
  limitOrOptions: number | ListGuardrailEventsOptions = 50,
  legacyFilters?: GuardrailEventFilters,
) {
  let limit = 50;
  let offset = 0;
  let filters: GuardrailEventFilters = {};

  if (typeof limitOrOptions === "number") {
    limit = limitOrOptions;
    if (legacyFilters) {
      filters = legacyFilters;
    }
  } else if (limitOrOptions && typeof limitOrOptions === "object") {
    if (typeof limitOrOptions.limit === "number") limit = limitOrOptions.limit;
    if (typeof limitOrOptions.offset === "number") offset = limitOrOptions.offset;
    if (limitOrOptions.filters) filters = limitOrOptions.filters;
  }

  const conditions = [eq(guardrailEvents.companyId, companyId)];
  const filterRule = filters.rule ?? filters.kind;
  if (filterRule) {
    conditions.push(or(eq(guardrailEvents.rule, filterRule), eq(guardrailEvents.kind, filterRule))!);
  }
  if (filters.mode) {
    conditions.push(eq(guardrailEvents.mode, filters.mode));
  }
  if (filters.level) {
    conditions.push(eq(guardrailEvents.level, filters.level));
  }
  const filterAgent = filters.agentId ?? filters.agent;
  if (filterAgent) {
    conditions.push(eq(guardrailEvents.agentId, filterAgent));
  }
  if (filters.decision) {
    conditions.push(eq(guardrailEvents.decision, filters.decision));
  }
  if (filters.severity) {
    conditions.push(eq(guardrailEvents.severity, filters.severity));
  }
  if (filters.surface) {
    conditions.push(eq(guardrailEvents.surface, filters.surface));
  }
  if (filters.runId) {
    conditions.push(eq(guardrailEvents.runId, filters.runId));
  }
  if (filters.issueId) {
    conditions.push(eq(guardrailEvents.issueId, filters.issueId));
  }

  const baseQuery = db
    .select()
    .from(guardrailEvents)
    .where(and(...conditions))
    .orderBy(desc(guardrailEvents.occurredAt))
    .limit(limit);

  const rows = offset > 0 ? await baseQuery.offset(offset) : await baseQuery;

  return rows.map((row) => ({
    ...row,
    rule: row.rule ?? row.kind,
    agent: row.agentId,
    ts: row.occurredAt,
  }));
}

/**
 * The run-output scan: detect on the text, mask once, record one event per
 * hit. Flag-only — the text is never modified. Returns the report so the
 * caller can decide what to log. Failures never propagate: the guardrail
 * must not break run finalization.
 */
export async function recordRunOutputGuardrailEvents(
  db: Db,
  input: {
    companyId: string;
    runId: string;
    issueId: string | null;
    agentId?: string | null;
    text: string | null;
    now(): Date;
    env?: NodeJS.ProcessEnv;
    modeHint?: "flag" | "mask" | "block";
    levelHint?: string;
  },
): Promise<{ recorded: number; total: number; totalSecrets: number; totalPii: number } | null> {
  const settings = readGuardrailOutputSettings(input.env);
  if (!settings.enabled) return null;
  if (typeof input.text !== "string" || input.text.trim().length === 0) return null;
  try {
    // Bounded scan: only the head of a huge output is examined.
    const text = input.text.slice(0, GUARDRAIL_SCAN_MAX_CHARS);
    const report = summarizeGuardrailHits(detectGuardrailHits(text, settings.categories));
    if (report.hits.length === 0) return { recorded: 0, total: 0, totalSecrets: 0, totalPii: 0 };
    // Redact EVERY detected fragment (all categories, independent of the
    // enabled ones) in the whole text first, then cut each snippet from the
    // redacted copy around its placeholder. A raw value is never in a snippet.
    const allHits = detectGuardrailHits(text, GUARDRAIL_CATEGORIES);
    const redacted = redactGuardrailHits(text, allHits);
    let agentId = input.agentId ?? null;
    if (!agentId && input.runId) {
      const [run] = await db
        .select({ agentId: heartbeatRuns.agentId })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, input.runId))
        .limit(1);
      if (run) {
        agentId = run.agentId;
      }
    }
    let recorded = 0;
    for (const hit of report.hits) {
      if (recorded >= GUARDRAIL_MAX_EVENTS_PER_RUN) break;
      const allIndex = allHits.findIndex((other) => other.span[0] < hit.span[1] && hit.span[0] < other.span[1]);
      if (allIndex < 0) continue;
      const snippet = guardrailSnippet(redacted.text, redacted.spans[allIndex]!, GUARDRAIL_SNIPPET_MAX_CHARS);
      const baseSeverity = hit.kind === "secret" ? "warn" : "info";
      const severity =
        input.modeHint === "block"
          ? "error"
          : input.modeHint === "mask"
            ? "warn"
            : baseSeverity;
      await recordGuardrailEvent(db, {
        companyId: input.companyId,
        issueId: input.issueId,
        runId: input.runId,
        agentId,
        kind: hit.kind,
        rule: hit.kind,
        mode: input.modeHint ?? "flag",
        level: input.levelHint ?? "company",
        decision: input.modeHint ?? "flag",
        surface: GUARDRAIL_SURFACE_RUN_OUTPUT,
        severity,
        snippet,
        occurredAt: input.now(),
      });
      recorded += 1;
    }
    return {
      recorded,
      total: report.hits.length,
      totalSecrets: report.totalSecrets,
      totalPii: report.totalPii,
    };
  } catch (err) {
    return null;
  }
}
