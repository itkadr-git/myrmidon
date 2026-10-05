// server/src/myrmidon/telegram-dm-progress/runtime-steps.ts
//
// myrmidon(DM-PROGRESS): a small in-memory step history per running run, for
// adapters that never write the native step events (`tool.execution.*` in
// heartbeat_run_events) — hermes_gateway and hermes_local report their live
// progress only through the runtime status (`ctx.onRuntimeProgress`, kept by
// services/heartbeat-run-runtime-status.ts, which holds the CURRENT status
// only) and through their run-log lines (`[tool] <name> <preview>`,
// `┊ <emoji> <verb> <detail> <duration>`).
//
// Steps are recorded at the source — every runtime status write and every
// stdout chunk — so a fast tool between two milestone sweeps is not lost. The
// history is bounded (a few distinct labels per run, a cap on runs, an idle
// TTL) and dropped when the run's runtime status is cleared at the end of the
// run. Same server process as the sweep that reads it; a restart only loses
// the step list of runs in flight (the status falls back to "работаю").

import type { HeartbeatRunRuntimeStatus } from "../../services/heartbeat-run-runtime-status.js";
import {
  DM_PROGRESS_ANSWER_LABEL,
  DM_PROGRESS_THINK_LABEL,
  dmProgressToolLabel,
  normalizeDmProgressToolName,
  type DmProgressStepKind,
} from "./labels.js";

export interface DmProgressRuntimeStep {
  kind: DmProgressStepKind;
  label: string;
  /** Normalized tool name, null for reasoning/answer steps. */
  toolName: string | null;
  /** Whether the label carries a target from the preview (richer label). */
  hasDetail: boolean;
  at: Date;
}

export const DM_PROGRESS_MAX_STEPS_PER_RUN = 6;
export const DM_PROGRESS_MAX_TRACKED_RUNS = 500;
export const DM_PROGRESS_RUN_IDLE_TTL_MS = 30 * 60_000;
const MAX_PARTIAL_LINE_CHARS = 2_000;
const SWEEP_EVERY_MS = 60_000;

interface RunSteps {
  steps: DmProgressRuntimeStep[];
  touchedAt: number;
  partialLine: string;
}

const runs = new Map<string, RunSteps>();
let lastSweepAt = 0;

function sweepIdle(now: number): void {
  if (now - lastSweepAt < SWEEP_EVERY_MS && runs.size <= DM_PROGRESS_MAX_TRACKED_RUNS) return;
  lastSweepAt = now;
  for (const [runId, entry] of runs) {
    if (now - entry.touchedAt > DM_PROGRESS_RUN_IDLE_TTL_MS) runs.delete(runId);
  }
  // Still over the cap: drop the least recently touched runs (Map keeps
  // insertion order and touched runs are re-inserted, so the head is oldest).
  while (runs.size > DM_PROGRESS_MAX_TRACKED_RUNS) {
    const oldest = runs.keys().next();
    if (oldest.done) break;
    runs.delete(oldest.value);
  }
}

function entryFor(runId: string, now: number): RunSteps {
  const existing = runs.get(runId);
  if (existing) {
    runs.delete(runId);
    existing.touchedAt = now;
    runs.set(runId, existing);
    return existing;
  }
  const created: RunSteps = { steps: [], touchedAt: now, partialLine: "" };
  runs.set(runId, created);
  sweepIdle(now);
  return created;
}

/**
 * Append one step to a run's history. Consecutive duplicates collapse; the
 * same tool reported twice (the gateway writes a `[tool]` log line with the
 * preview and then a runtime status with the bare name, in either order)
 * keeps the richer label instead of stacking a second entry.
 */
export function recordDmProgressStep(
  runId: string,
  step: Omit<DmProgressRuntimeStep, "at"> & { at?: Date },
): void {
  const at = step.at ?? new Date();
  const entry = entryFor(runId, at.getTime());
  const last = entry.steps[entry.steps.length - 1];
  const next: DmProgressRuntimeStep = { ...step, at };
  if (last) {
    if (last.label === next.label) {
      last.at = at;
      return;
    }
    if (last.toolName !== null && last.toolName === next.toolName && last.kind === next.kind) {
      if (!next.hasDetail) {
        // The bare-name report of the same call: keep the richer label.
        return;
      }
      if (!last.hasDetail) {
        entry.steps[entry.steps.length - 1] = next;
        return;
      }
    }
  }
  entry.steps.push(next);
  if (entry.steps.length > DM_PROGRESS_MAX_STEPS_PER_RUN) {
    entry.steps.splice(0, entry.steps.length - DM_PROGRESS_MAX_STEPS_PER_RUN);
  }
}

/**
 * Feed one runtime status write (services/heartbeat-run-runtime-status.ts).
 * Only statuses that name real work become steps: a tool in progress, the
 * reasoning phase, or the answer being streamed. Generic activity touches
 * ("Receiving agent output") and tool completions ("Used <tool>") do not.
 */
export function recordDmProgressRuntimeStatus(
  status: Pick<
    HeartbeatRunRuntimeStatus,
    "runId" | "message" | "currentToolName" | "lastAssistantSnippet" | "updatedAt"
  >,
): void {
  const at = status.updatedAt ?? new Date();
  const message = status.message.trim();
  if (status.currentToolName) {
    if (/^used\b/i.test(message)) return;
    const label = dmProgressToolLabel({ toolName: status.currentToolName });
    recordDmProgressStep(status.runId, {
      ...label,
      toolName: normalizeDmProgressToolName(status.currentToolName),
      hasDetail: false,
      at,
    });
    return;
  }
  if (/^reasoning\b/i.test(message)) {
    recordDmProgressStep(status.runId, { ...DM_PROGRESS_THINK_LABEL, toolName: null, hasDetail: false, at });
    return;
  }
  if (status.lastAssistantSnippet) {
    recordDmProgressStep(status.runId, { ...DM_PROGRESS_ANSWER_LABEL, toolName: null, hasDetail: false, at });
  }
}

/** One parsed run-log line: a tool with its preview, reasoning, or answer text. */
export type DmProgressLogLine =
  | { type: "tool"; toolName: string; preview: string }
  | { type: "think" }
  | { type: "answer" };

const TOOL_OUTPUT_PREFIX = "┊";

function stripAnsi(text: string): string {
  return text
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, "")
    .replace(/\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
}

function stripDecorations(text: string): string {
  // Parenthesized kaomoji faces and a leading pictograph, as Hermes prints them.
  return text
    .replace(/[(][^()]{2,20}[)]\s*/gu, "")
    .replace(/^\p{Extended_Pictographic}️?\s*/u, "")
    .trim();
}

function splitVerb(rest: string): { verb: string; detail: string } | null {
  const match = rest.match(/^(\S+)\s*(.*)$/);
  if (!match?.[1]) return null;
  return { verb: match[1], detail: (match[2] ?? "").trim() };
}

/**
 * Parse one Hermes run-log line. Recognized shapes:
 * - `[tool] <name> <preview>` (gateway compact start line; the CLI's
 *   non-quiet start line, with a kaomoji face and an emoji before the verb);
 * - `[done] ┊ <emoji> <verb> <detail>  <duration>s` and
 *   `┊ <emoji> <verb> <detail>  <duration>s` (tool completion lines);
 * - `┊ 💭 …` (reasoning) and `┊ 💬 …` (answer text).
 * Anything else returns null.
 */
export function parseDmProgressLogLine(rawLine: string): DmProgressLogLine | null {
  const line = stripAnsi(rawLine).trim();
  if (!line) return null;
  if (line.startsWith("[tool]")) {
    const parts = splitVerb(stripDecorations(line.slice("[tool]".length).trim()));
    if (!parts) return null;
    return { type: "tool", toolName: parts.verb, preview: parts.detail };
  }
  const cleaned = line.replace(/^\[done\]\s*/, "");
  if (!cleaned.startsWith(TOOL_OUTPUT_PREFIX)) return null;
  const body = cleaned.slice(TOOL_OUTPUT_PREFIX.length).trim();
  if (/^💭/u.test(body)) return { type: "think" };
  if (/^💬/u.test(body)) return { type: "answer" };
  const withoutDuration = stripDecorations(body)
    .replace(/\s*\[(?:exit \d+|error|full)\]\s*$/, "")
    .replace(/\s+[\d.]+s\s*(?:\([\d.]+s\))?\s*$/, "")
    .trim();
  const parts = splitVerb(withoutDuration);
  if (!parts) return null;
  return { type: "tool", toolName: parts.verb, preview: parts.detail === "·" ? "" : parts.detail };
}

/**
 * Feed one run-log chunk (stdout only). Lines may straddle chunks, so the
 * unfinished tail is kept (bounded) until the next chunk completes it.
 */
export function recordDmProgressLogChunk(
  runId: string,
  stream: "stdout" | "stderr",
  chunk: string,
  at: Date = new Date(),
): void {
  if (stream !== "stdout" || !chunk) return;
  const existing = runs.get(runId);
  const pending = existing?.partialLine ?? "";
  // Cheap gate: a chunk without any recognized marker and no pending tail
  // cannot produce a step.
  if (!pending && !chunk.includes("[tool]") && !chunk.includes(TOOL_OUTPUT_PREFIX)) return;
  const text = pending + chunk;
  const lines = text.split("\n");
  const tail = lines.pop() ?? "";
  for (const line of lines) {
    const parsed = parseDmProgressLogLine(line);
    if (!parsed) continue;
    if (parsed.type === "think") {
      recordDmProgressStep(runId, { ...DM_PROGRESS_THINK_LABEL, toolName: null, hasDetail: false, at });
    } else if (parsed.type === "answer") {
      recordDmProgressStep(runId, { ...DM_PROGRESS_ANSWER_LABEL, toolName: null, hasDetail: false, at });
    } else {
      const label = dmProgressToolLabel({ toolName: parsed.toolName, preview: parsed.preview });
      const bare = dmProgressToolLabel({ toolName: parsed.toolName });
      recordDmProgressStep(runId, {
        ...label,
        toolName: normalizeDmProgressToolName(parsed.toolName),
        hasDetail: label.label !== bare.label,
        at,
      });
    }
  }
  const keepTail = tail.length > MAX_PARTIAL_LINE_CHARS ? "" : tail;
  if (keepTail || runs.has(runId)) {
    entryFor(runId, at.getTime()).partialLine = keepTail;
  }
}

/** The run's recorded steps, oldest first (a copy). */
export function readDmProgressRuntimeSteps(runId: string, now: Date = new Date()): DmProgressRuntimeStep[] {
  const entry = runs.get(runId);
  if (!entry) return [];
  if (now.getTime() - entry.touchedAt > DM_PROGRESS_RUN_IDLE_TTL_MS) {
    runs.delete(runId);
    return [];
  }
  return entry.steps.map((step) => ({ ...step, at: new Date(step.at) }));
}

/** Drop one run's history (its runtime status was cleared: the run ended). */
export function clearDmProgressRuntimeSteps(runId: string): void {
  runs.delete(runId);
}

/** Drop every run's history (tests, and the runtime status store's reset). */
export function clearAllDmProgressRuntimeSteps(): void {
  runs.clear();
  lastSweepAt = 0;
}
