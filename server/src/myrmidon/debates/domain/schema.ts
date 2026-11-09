// server/src/myrmidon/debates/domain/schema.ts
//
// myrmidon(1.7 DEBATE-ASYM, OPE-12076): validation of the debate domain —
// the participant roles and the shape of a persisted run. The judge is
// structurally outside the dispute (validateDebateParticipants rejects a
// pro/contra run whose judge id collides with a pole, and every round
// statement is required to come from one of the two poles).

import { z } from "zod";
import {
  DEBATE_RUN_STATES,
  type DebateParticipant,
  type DebateParticipantRole,
  type DebateRun,
  type DebateRunState,
  type DebateStatement,
} from "./types.js";

export const debateParticipantRoleSchema = z.enum(["pro", "contra", "judge"]);

export const debateParticipantSchema = z.object({
  id: z.string().min(1),
  role: debateParticipantRoleSchema,
  model: z.string().min(1),
});

export const debateRunStateSchema = z.enum(DEBATE_RUN_STATES);

export const debateStatementSchema: z.ZodType<DebateStatement> = z.object({
  participantId: z.string().min(1),
  round: z.number().int().min(0),
  text: z.string(),
});

export const debateParticipantListSchema = z
  .array(debateParticipantSchema)
  .refine((participants) => {
    const ids = new Set(participants.map((p) => p.id));
    return ids.size === participants.length;
  }, "participant ids must be unique within a run");

export const debateRunConfigSchema = z.object({
  question: z.string().min(1),
  maxRounds: z.number().int().min(1),
  tokenCeiling: z.number().int().positive().nullable(),
});

/**
 * The persisted run schema. Cross-field rules (prologue):
 * the three referenced participants must exist, have the right roles, and the
 * round bookkeeping must agree with the collected rounds.
 */
export const debateRunSchema: z.ZodType<DebateRun> = z
  .object({
    id: z.string().min(1),
    state: debateRunStateSchema,
    question: z.string().min(1),
    proParticipantId: z.string().min(1),
    contraParticipantId: z.string().min(1),
    judgeParticipantId: z.string().min(1),
    participants: z.record(z.string(), debateParticipantSchema),
    prompts: z.object({
      pro: z.string().min(1),
      contra: z.string().min(1),
    }),
    maxRounds: z.number().int().min(1),
    tokenCeiling: z.number().int().positive().nullable(),
    roundCount: z.number().int().min(0),
    rounds: z.array(
      z.object({
        index: z.number().int().min(0),
        pro: debateStatementSchema,
        contra: debateStatementSchema,
      }),
    ),
    verdict: z
      .object({
        participantId: z.string().min(1),
        text: z.string(),
      })
      .nullable(),
    tokensUsed: z.number().int().min(0),
  })
  .refine((run) => participantsAgree(run), "participants disagree with the run references")
  .refine((run) => run.roundCount <= run.maxRounds, "roundCount must not exceed maxRounds")
  .refine((run) => run.roundCount === run.rounds.length, "roundCount must equal the number of collected rounds")
  .refine((run) => roundsAreOrdered(run), "rounds must be collected in order without gaps")
  .refine((run) => roundsUsePolarSidesOnly(run), "rounds must contain only pro and contra statements")
  .refine(
    (run) => (run.state === "draft" ? run.roundCount === 0 : true),
    "a draft run has no collected rounds yet",
  )
  .refine(
    (run) => (run.verdict !== null ? run.state === "judge_verdict" || run.state === "done" : true),
    "a verdict exists only after the judge stage",
  );

function participantsAgree(run: DebateRun): boolean {
  const pro = run.participants[run.proParticipantId];
  const contra = run.participants[run.contraParticipantId];
  const judge = run.participants[run.judgeParticipantId];
  return (
    pro?.role === "pro" && contra?.role === "contra" && judge?.role === "judge"
  );
}

function roundsAreOrdered(run: DebateRun): boolean {
  return run.rounds.every((round, position) => round.index === position);
}

function roundsUsePolarSidesOnly(run: DebateRun): boolean {
  return run.rounds.every(
    (round) =>
      round.pro.participantId === run.proParticipantId &&
      round.contra.participantId === run.contraParticipantId &&
      round.pro.participantId !== run.judgeParticipantId &&
      round.contra.participantId !== run.judgeParticipantId,
  );
}

/** The parsed participant list, or the validation problem. */
export function validateDebateParticipants(participants: unknown): {
  participants: DebateParticipant[] | null;
  problem: string | null;
} {
  const parsed = debateParticipantListSchema.safeParse(participants);
  if (!parsed.success) {
    return { participants: null, problem: parsed.error.issues[0]?.message ?? "invalid participants" };
  }
  const roles = new Set(parsed.data.map((p) => p.role));
  const judgeCount = [...parsed.data].filter((p) => p.role === "judge").length;
  if (roles.size !== 3 || judgeCount !== 1) {
    return { participants: null, problem: "a debate needs exactly one pro, one contra, and one judge" };
  }
  return { participants: parsed.data, problem: null };
}

/** Parse a run state, reporting the problem instead of throwing. */
export function parseDebateRunState(raw: unknown): { state: DebateRunState | null; problem: string | null } {
  const parsed = debateRunStateSchema.safeParse(raw);
  if (!parsed.success) {
    return { state: null, problem: `unknown debate run state: ${String(raw)}` };
  }
  return { state: parsed.data, problem: null };
}

/** Parse a participant role, reporting the problem instead of throwing. */
export function parseDebateParticipantRole(raw: unknown): {
  role: DebateParticipantRole | null;
  problem: string | null;
} {
  const parsed = debateParticipantRoleSchema.safeParse(raw);
  if (!parsed.success) {
    return { role: null, problem: `unknown debate participant role: ${String(raw)}` };
  }
  return { role: parsed.data, problem: null };
}

/** Validate a full debate run; null with a problem when the shape is broken. */
export function validateDebateRun(run: unknown): { run: DebateRun | null; problem: string | null } {
  const parsed = debateRunSchema.safeParse(run);
  if (!parsed.success) {
    return { run: null, problem: parsed.error.issues[0]?.message ?? "invalid debate run" };
  }
  return { run: parsed.data, problem: null };
}
