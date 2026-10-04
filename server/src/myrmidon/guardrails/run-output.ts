// server/src/myrmidon/guardrails/run-output.ts
//
// myrmidon(1.6-GRD): the single run-output hook the heartbeat finalization
// calls. It reads the env switch, detects on the run's final text (the same
// text that lands in the issue comment / result), and journals flag-only
// events. The hot files (heartbeat.ts, issues.ts) get one import line and
// one guarded call line each, both behind `// myrmidon(1.6-GRD)` markers;
// every bit of logic lives here.
//
// Off by default (MYRMIDON_GUARDRAILS_OUTPUT_ENABLED); the flag is turned on
// at rollout. Nothing is masked and nothing is blocked in 1.6.1.
//
// myrmidon(1.7-GRD-MODES): the hook also resolves the per-agent enforcement
// modes (OPE-4167) and returns a decision the heartbeat executes BEFORE the
// text becomes the issue comment:
//
//   flag  — the text continues unchanged (journal as before);
//   mask  — the text with every hit span replaced by [masked] continues;
//   block — the text is replaced by a refusal naming the rule.
//
// The 1.6.1 env switch keeps its role of turning the whole layer on/off; the
// modes only choose what a hit DOES once the layer is on. The mode is
// resolved per evaluation (fresh read of instance_settings), so a mode
// change in the UI acts on the NEXT run answer without a restart.

import type { Db } from "@paperclipai/db";
import type { GuardrailMode } from "@paperclipai/shared";
import { recordRunOutputGuardrailEvents } from "./events.js";
import {
  guardrailBlockRefusal,
  maskGuardrailSpans,
  resolveGuardrailModeForAgent,
  type GuardrailModeEnforcement,
} from "./modes.js";
import { detectGuardrailHits } from "./detect.js";

/** Options the heartbeat passes down; all fields optional in tests. */
export interface GuardrailRunOutputInput {
  db: Db;
  companyId: string;
  runId: string;
  issueId: string | null;
  /** The final text of the run — what the comment would carry. */
  text: string | null;
  /** Whose run this is — mode resolution is per agent (1.7-GRD-MODES). */
  agentId: string;
  env?: NodeJS.ProcessEnv;
  now?(): Date;
}

/**
 * The decision the heartbeat executes on the final run text. `text` is what
 * the issue comment should carry AFTER the mode ran: unchanged for flag,
 * span-masked for mask, the refusal for block. `hits` 0 means the layer did
 * not evaluate (off / empty text / no hits) and the original text continues.
 */
export interface GuardrailRunOutputDecision {
  mode: GuardrailMode;
  rule: "secret" | "pii";
  source: GuardrailModeEnforcement["source"];
  caste: string | null;
  /** The text to continue with; null when the layer did not run. */
  text: string | null;
  /** How many detector hits fired (0 when the layer is off or text empty). */
  hits: number;
}

export async function guardrailsOnRunOutput(
  input: GuardrailRunOutputInput,
): Promise<GuardrailRunOutputDecision> {
  // Resolve the mode BEFORE journaling so the event severity reflects what
  // the hit actually did (mask -> warn, block -> error).
  const enforcement = await resolveGuardrailModeForAgent({
    db: input.db,
    companyId: input.companyId,
    agentId: input.agentId,
    env: input.env,
    rule: "secret",
  });
  const base = await recordRunOutputGuardrailEvents(input.db, {
    companyId: input.companyId,
    runId: input.runId,
    issueId: input.issueId,
    text: input.text,
    now: input.now ?? (() => new Date()),
    env: input.env,
    modeHint: enforcement.mode,
  });
  // Layer off, empty text or no hits: nothing changes, whatever the mode.
  if (base === null || base.total === 0 || typeof input.text !== "string") {
    return {
      mode: "flag",
      rule: "secret",
      source: "default",
      caste: null,
      text: input.text,
      hits: 0,
    };
  }
  // The rule whose mode governs the whole text: secrets win over pii (the
  // stricter family decides, matching the detector's own overlap priority).
  const rule: "secret" | "pii" = base.totalSecrets > 0 ? "secret" : "pii";
  const mode = await enforcementForRule(input, enforcement, rule);
  if (mode.mode === "flag") {
    return {
      mode: mode.mode,
      rule,
      source: mode.source,
      caste: mode.caste,
      text: input.text,
      hits: base.total,
    };
  }
  const spans = detectGuardrailHits(input.text)
    .filter((hit) => hit.kind === rule)
    .map((hit) => ({ span: hit.span }));
  if (mode.mode === "mask") {
    return {
      mode: mode.mode,
      rule,
      source: mode.source,
      caste: mode.caste,
      text: maskGuardrailSpans(input.text, spans),
      hits: base.total,
    };
  }
  return {
    mode: mode.mode,
    rule,
    source: mode.source,
    caste: mode.caste,
    text: guardrailBlockRefusal({ rule, hits: base.total, source: mode.source }),
    hits: base.total,
  };
}

/**
 * Re-resolve for the deciding rule: the secret-mode pass above may not be
 * the rule that governs (a pii-only text with a secret mode set). The second
 * read is one more primary-key lookup on the same settings row.
 */
async function enforcementForRule(
  input: GuardrailRunOutputInput,
  current: GuardrailModeEnforcement,
  rule: "secret" | "pii",
): Promise<GuardrailModeEnforcement> {
  if (current.rule === rule) return current;
  return resolveGuardrailModeForAgent({
    db: input.db,
    companyId: input.companyId,
    agentId: input.agentId,
    env: input.env,
    rule,
  });
}
