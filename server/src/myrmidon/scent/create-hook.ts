// server/src/myrmidon/scent/create-hook.ts
//
// myrmidon(1.6.5 F-26 T10 SCENT): the issue-create hook (design §2.1, §2.4,
// §7.1 п.4a). One pass over the values the caller sent, BEFORE the row is
// inserted, pure and synchronous:
//
//   caste:   casteKey sent       → kept as-is, casteSource := 'manual'
//            (never overwritten, no matter what the client claims the source
//            was — an explicit key is a manual decision)
//            no casteKey, scent top ≥ 0.5 → casteKey := that caste,
//                                           casteSource := 'auto'
//            otherwise            → NOTHING is written: casteKey stays NULL
//                                   and the §2.1 resolution chain
//                                   (task ?? project default ?? company
//                                   default, server/src/myrmidon/castes/
//                                   resolve.ts) applies at read time. In
//                                   particular the hook NEVER materializes
//                                   the company default caste with
//                                   casteSource 'auto' — that would shadow
//                                   the project default and pollute the
//                                   "auto" label.
//
//   strength: pheromoneStrength sent → kept as-is
//            otherwise              → scentTaskStrength(priority, scent)
//                                   (priority base + consequencesBonus on a
//                                   really consequential task).
//
// A caller-sent `casteSource` is only trusted when it matches the value the
// hook derives — anything else is rewritten (the label is server state, not
// user input).
//
// The hook NEVER calls the classifier itself: issue creation must not block
// on an LLM (up to 20 s of timeout) — the scent arrives asynchronously from
// the markup queue / the refresh route. A task without a description is not
// classified at all (§2.4) and rides the chain with casteKey NULL.

import {
  scentTaskStrength,
  topScentCasteKey,
  type IssueScent,
  type ScentSettings,
} from "@paperclipai/shared";

/** The subset of issue-create input the hook reads and may amend. */
export interface ScentCreateHookInput {
  title: string;
  description?: string | null;
  priority?: string;
  casteKey?: string | null;
  casteSource?: string | null;
  pheromoneStrength?: number | null;
  scent?: IssueScent | null;
}

export interface ScentAutoResult {
  casteKey: string | null;
  casteSource: "manual" | "auto" | null;
  pheromoneStrength: number;
}

/**
 * Pure derivation — no I/O, no env. Returns the caste/strength values to
 * write for a new issue given what the caller sent. `casteKeys` is the
 * company's caste directory (auto assignment is dropped when the winning
 * caste is not in the directory — defense in depth on top of the gateway's
 * key-wise filtering).
 */
export function deriveScentAuto(
  input: ScentCreateHookInput,
  casteKeys: readonly string[],
  settings?: Pick<ScentSettings, "consequencesBonus" | "consequencesBonusThreshold">,
): ScentAutoResult {
  const explicitCaste = typeof input.casteKey === "string" && input.casteKey.trim() !== "";
  const casteKey = explicitCaste ? input.casteKey!.trim() : null;
  const casteSource: "manual" | "auto" | null = explicitCaste ? "manual" : null;

  let resolvedCasteKey: string | null = casteKey;
  let resolvedSource: "manual" | "auto" | null = casteSource;
  if (!explicitCaste) {
    const topKey = topScentCasteKey(input.scent ?? null);
    if (topKey && casteKeys.includes(topKey)) {
      resolvedCasteKey = topKey;
      resolvedSource = "auto";
    }
    // Otherwise: NULL + NULL — the §2.1 chain (project default ?? company
    // default) resolves at read time; nothing is materialized here.
  }

  const explicitStrength =
    typeof input.pheromoneStrength === "number" &&
    Number.isFinite(input.pheromoneStrength);
  const pheromoneStrength = explicitStrength
    ? Math.max(0, Math.round(input.pheromoneStrength!))
    : scentTaskStrength(input.priority ?? "medium", input.scent ?? null, settings);

  return {
    casteKey: resolvedCasteKey,
    casteSource: resolvedSource,
    pheromoneStrength,
  };
}

/** True when the task must not go to the classifier at all (§2.4). */
export function isUnclassifiableIssue(input: Pick<ScentCreateHookInput, "description">): boolean {
  return !input.description || input.description.trim() === "";
}
