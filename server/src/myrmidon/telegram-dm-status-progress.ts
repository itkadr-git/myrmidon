import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@myrmidon/db";
import { heartbeatRunEvents } from "@myrmidon/db";
import { redactSensitiveText } from "../redaction.js";
// myrmidon(DM-PROGRESS): legacy adapters (hermes_gateway, hermes_local) write
// no native step events; their steps come from the in-memory runtime history.
import { labelForStepFacts } from "./telegram-dm-progress/labels.js";
import type { DmProgressRuntimeStep } from "./telegram-dm-progress/runtime-steps.js";
import { dmProgressTexts, type DmProgressTextLocale } from "./telegram-dm-progress/texts.js";

// myrmidon(OPE-3650): live progress text for the editable Telegram DM status
// row (MYRMIDON_TELEGRAM_DM_STATUS). The owner asked to see WHAT the bot is
// doing right now — the current step in plain words, elapsed time, and the
// last few completed steps — updated in place in the single durable status
// message, never as new provider messages.
//
// myrmidon(1.7-TG-LOCALE): every word of the status text comes from the
// telegram-dm-progress texts.ts catalog in the instance locale (`ru` keeps
// the pre-catalog wording byte-for-byte; `en` renders "<1 min", "N min",
// "H h M min"). The locale is passed in by the publisher (no user in a
// publication row, so the instance menu locale is the language) and defaults
// to "ru" — the fork's historical wording.
//
// Source of truth: the run-log rows the board already records
// (`heartbeat_run_events`; a run-log path, no extra review per AGENTS.md §7).
// Only event identity/type/sequence/time and the already-redacted `message`
// column are read here; raw payloads, tool arguments, and results never
// cross into provider text. Events are redacted with redactSensitiveText at
// the append boundary (appendRunEvent); the label reader re-applies it as a
// second guard and truncates hard.

const DM_STATUS_STEP_EVENT_TYPES = [
  "tool.execution.started",
  "tool.execution.completed",
  "research.started",
  "research.completed",
  "delegation.started",
  "delegation.completed",
  "plan.updated",
  "item.completed",
] as const;

const DM_STATUS_STEP_EVENT_TYPE_SET = new Set<string>(DM_STATUS_STEP_EVENT_TYPES);

export function isDmStatusStepEventType(eventType: string): boolean {
  return DM_STATUS_STEP_EVENT_TYPE_SET.has(eventType);
}

const MAX_CURRENT_STEP_CHARS = 120;
const MAX_COMPLETED_STEPS = 3;
const MAX_COMPLETED_STEP_CHARS = 80;

function normalizeStepText(value: string, maxChars: number): string | null {
  const normalized = value.replace(/\s+/g, " ").trim().slice(0, maxChars);
  if (!normalized) return null;
  // Second guard: the append boundary already redacted these fields, but the
  // status text crosses to an external provider, so re-apply the closed
  // redaction before it leaves.
  return redactSensitiveText(normalized) || null;
}

function stepLabelForEventType(
  eventType: string,
  message: string | null,
  locale: DmProgressTextLocale | null,
): string | null {
  const texts = dmProgressTexts(locale);
  switch (eventType) {
    case "tool.execution.started":
      return message ? texts.events.toolStarted(message) : texts.events.toolStartedFallback;
    case "tool.execution.completed":
      return message ? texts.events.toolCompleted(message) : null;
    case "research.started":
      return texts.events.researchStarted;
    case "research.completed":
      return texts.events.researchCompleted;
    case "delegation.started":
      return message ? texts.events.delegationStarted(message) : texts.events.delegationStartedFallback;
    case "delegation.completed":
      return texts.events.delegationCompleted;
    case "plan.updated":
      return message ? texts.events.planUpdated(message) : texts.events.planUpdatedFallback;
    case "item.completed":
      return message ? texts.events.itemCompleted(message) : null;
    default:
      return message;
  }
}

export type DmStatusStep = {
  eventType: string;
  message: string | null;
  createdAt: Date;
};

/**
 * The elapsed-time line: "<1 мин" / "<1 min" under a minute, "N мин" /
 * "N min" under an hour, "H ч M мин" / "H h M min" above. Coarse buckets: the
 * elapsed string participates in the payload-changed comparison that gates
 * provider edits, so a per-second clock would edit the Telegram message on
 * every 1s sweep. 30s buckets keep edits well inside Telegram's per-message
 * edit rate limit while the elapsed line still advances a few times per
 * minute.
 */
export function formatDmStatusElapsed(
  startedAt: Date | null,
  now: Date,
  locale: DmProgressTextLocale | null = "ru",
): string {
  if (!startedAt) return "";
  const seconds = Math.max(0, Math.floor((now.getTime() - startedAt.getTime()) / 1000));
  const bucketed = Math.floor(seconds / 30) * 30;
  const texts = dmProgressTexts(locale).elapsed;
  if (bucketed < 60) return texts.underMinute;
  const minutes = Math.floor(bucketed / 60);
  if (minutes < 60) return `${minutes} ${texts.minuteUnit}`;
  return `${Math.floor(minutes / 60)} ${texts.hourUnit} ${minutes % 60} ${texts.minuteUnit}`;
}

/**
 * One runtime-history step as the composer accepts it: the full recorded
 * facts (kind, tool name, structured target) or a legacy bare `{ label }`
 * string a caller composed itself. Full facts render per locale; a bare
 * label passes through verbatim (the caller owns its wording).
 */
export type DmStatusRuntimeStep =
  | Pick<DmProgressRuntimeStep, "kind" | "toolName" | "label">
  | { label: string };

function stepLabelForRuntimeStep(step: DmStatusRuntimeStep, locale: DmProgressTextLocale | null): string {
  if ("kind" in step) {
    const withTarget = step as Pick<DmProgressRuntimeStep, "kind" | "toolName" | "label"> & {
      target?: DmProgressRuntimeStep["target"];
    };
    return labelForStepFacts(
      {
        kind: withTarget.kind,
        toolName: withTarget.toolName,
        target: withTarget.target ?? null,
      },
      locale,
    );
  }
  return step.label;
}

/**
 * Compose the live-progress status text for the bridged Telegram DM status
 * row: the agent's current step in plain words, the elapsed time, and the
 * last few completed steps as a short list. Falls back to "работаю" /
 * "working" with the elapsed time when the run has no steps yet.
 *
 * myrmidon(DM-PROGRESS): steps come from the native run-log events when the
 * run has any; otherwise from the runtime step history of legacy adapters
 * (`runtimeSteps`, recorded language-neutrally and rendered here in the
 * chosen locale; a bare `{ label }` passes through as the caller wrote it).
 * `showSteps: false` keeps the message to the milestone and the elapsed time.
 *
 * myrmidon(1.7-TG-LOCALE): `locale` (default "ru", the fork's historical
 * wording) renders every service word and every recorded step's label.
 */
export function composeDmStatusText(input: {
  agentName: string;
  milestone: "queued" | "working";
  startedAt: Date | null;
  steps: DmStatusStep[];
  runtimeSteps?: readonly DmStatusRuntimeStep[];
  showSteps?: boolean;
  locale?: DmProgressTextLocale | null;
  now: Date;
}): string {
  const locale = input.locale ?? "ru";
  const texts = dmProgressTexts(locale);
  if (input.milestone === "queued") return `${input.agentName}: ${texts.queued}`;

  const showSteps = input.showSteps ?? true;
  const nativeLabels = showSteps
    ? input.steps
        .map((step) => {
          const message = step.message ? normalizeStepText(step.message, MAX_CURRENT_STEP_CHARS) : null;
          return stepLabelForEventType(step.eventType, message, locale);
        })
        .filter((label): label is string => label !== null)
    : [];
  const labels =
    nativeLabels.length > 0 || !showSteps
      ? nativeLabels
      : (input.runtimeSteps ?? [])
          .map((step) => normalizeStepText(stepLabelForRuntimeStep(step, locale), MAX_CURRENT_STEP_CHARS))
          .filter((label): label is string => label !== null);

  const elapsed = formatDmStatusElapsed(input.startedAt, input.now, locale);
  if (labels.length === 0) {
    return elapsed
      ? `${input.agentName}: ${texts.working} ${texts.elapsed.separator} ${elapsed}`
      : `${input.agentName}: ${texts.working}`;
  }

  const current = labels[labels.length - 1]!;
  const completed = labels
    .slice(Math.max(0, labels.length - 1 - MAX_COMPLETED_STEPS), labels.length - 1)
    .map((label) => normalizeStepText(label, MAX_COMPLETED_STEP_CHARS))
    .filter((label): label is string => label !== null);

  const lines = [`${input.agentName}: ${current}${elapsed ? ` ${texts.elapsed.separator} ${elapsed}` : ""}`];
  if (completed.length > 0) {
    lines.push("", texts.doneHeader);
    for (const label of completed) lines.push(`• ${label}`);
  }
  return lines.join("\n");
}

/**
 * Read the most recent step-family run-log events for one run, bounded, for
 * the DM status text. Only the already-redacted `message` column and event
 * identity are projected; payloads are never read here.
 */
export async function readDmStatusSteps(
  db: Db,
  input: { companyId: string; runId: string; limit?: number },
): Promise<DmStatusStep[]> {
  const limit = Math.max(1, Math.min(input.limit ?? 8, 16));
  const rows = await db
    .select({
      eventType: heartbeatRunEvents.eventType,
      message: heartbeatRunEvents.message,
      createdAt: heartbeatRunEvents.createdAt,
    })
    .from(heartbeatRunEvents)
    .where(
      and(
        eq(heartbeatRunEvents.companyId, input.companyId),
        eq(heartbeatRunEvents.runId, input.runId),
        inArray(heartbeatRunEvents.eventType, [...DM_STATUS_STEP_EVENT_TYPES]),
      ),
    )
    .orderBy(desc(heartbeatRunEvents.id))
    .limit(limit);
  // Query returns newest-first; the composer reads oldest-first semantics.
  return rows.reverse().map((row) => ({
    eventType: row.eventType,
    message: row.message,
    createdAt: row.createdAt,
  }));
}
