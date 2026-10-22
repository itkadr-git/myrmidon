// myrmidon(1.7-GRD-CI): rule registry for the GUARDRAILS corpus eval.
//
// Maps the corpus detectors (1.6.1 part C: `expect.detector`) onto the
// shipped detectors so the harness can run them:
//
//   - injection — GUARDRAILS part B (on main): the heuristic scan at the
//     default threshold; the env-configured threshold is deliberately NOT
//     read here, the eval is a fixed measurement of the shipped default.
//   - secret / pii — GUARDRAILS part A (the pattern detectors): loaded
//     optionally, because the module lives behind its merge — while
//     `../detect.ts` is not on main yet the rules are registered as
//     `pending-base-layer` (reported, not gating); the moment the module
//     merges, the import resolves and the rules activate without any
//     change to this code.
//
// No env, no process state: everything the eval measures is fixed by the
// code so the committed artifact stays reproducible.

import { scanForInjection, DEFAULT_INJECTION_SCORE_THRESHOLD } from "../injection.js";
import type { EvalRule } from "./evaluate.js";

/** The shape of `../detect.js` the eval uses (the part-A module). */
export interface OutputDetectModule {
  detectGuardrailHits: (
    text: string,
    categories: readonly ("secret" | "pii")[],
  ) => readonly { kind: "secret" | "pii" }[];
}

/** The injection rule: fires when the heuristic scan flags the text. */
export function injectionRule(): EvalRule {
  return {
    id: "injection",
    surface: "input (wake payload)",
    status: "active",
    scan: (text: string) => {
      const result = scanForInjection(text, DEFAULT_INJECTION_SCORE_THRESHOLD);
      return { fired: result.flagged, detail: result.matched };
    },
  };
}

/** Secret/pii rules from the part-A detector module. */
export function outputRules(detect: OutputDetectModule): EvalRule[] {
  const fired = (kind: "secret" | "pii") => (text: string) => ({
    fired: detect.detectGuardrailHits(text, [kind]).some((hit) => hit.kind === kind),
  });
  return [
    { id: "secret", surface: "run output", status: "active", scan: fired("secret") },
    { id: "pii", surface: "run output", status: "active", scan: fired("pii") },
  ];
}

/** Secret/pii rules before part A merges: measured coverage, not gating. */
export function pendingOutputRules(): EvalRule[] {
  return [
    { id: "secret", surface: "run output", status: "pending-base-layer", scan: () => ({ fired: false }) },
    { id: "pii", surface: "run output", status: "pending-base-layer", scan: () => ({ fired: false }) },
  ];
}

/**
 * Tries to load the part-A output detector module (`../detect.js`). Returns
 * null when the module is not on this revision (part A not merged yet).
 * The specifier is a variable so TypeScript does not resolve it statically.
 */
export async function loadOutputDetectModule(): Promise<OutputDetectModule | null> {
  const specifier = "../detect.js";
  try {
    // deno-lint-ignore no-explicit-any — optional sibling module
    const mod = (await import(specifier)) as any;
    if (typeof mod.detectGuardrailHits === "function") {
      return mod as OutputDetectModule;
    }
    return null;
  } catch {
    return null;
  }
}

/** The full rule list the eval runs: injection plus the output detectors. */
export async function buildRules(): Promise<EvalRule[]> {
  const detect = await loadOutputDetectModule();
  const output = detect ? outputRules(detect) : pendingOutputRules();
  return [injectionRule(), ...output];
}
