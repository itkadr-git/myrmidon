// packages/shared/src/myrmidon-guardrail-regex.ts
//
// myrmidon(1.7 GUARDRAILS, OPE-10181): regex rule validator & ReDoS safety engine.
//
// When configuring custom guardrail rules, regex patterns entered by operators
// must be validated for syntax correctness, complexity, and catastrophic
// backtracking (ReDoS) vulnerability before being accepted and executed in
// runtime guardrails.

import { z } from "zod";

export const GUARDRAIL_REGEX_COMPLEXITY_LEVELS = [
  "safe",
  "low",
  "medium",
  "high",
  "vulnerable",
] as const;

export type GuardrailRegexComplexity = (typeof GUARDRAIL_REGEX_COMPLEXITY_LEVELS)[number];

export interface GuardrailRegexSampleMatch {
  input: string;
  matched: boolean;
  error?: string;
}

export interface GuardrailRegexValidationResult {
  valid: boolean;
  pattern: string;
  flags: string;
  redosRisk: boolean;
  riskReason?: string;
  complexity: GuardrailRegexComplexity;
  sampleMatches?: GuardrailRegexSampleMatch[];
  error?: string;
}

export const VALID_REGEX_FLAGS = new Set(["d", "g", "i", "m", "s", "u", "v", "y"]);

export const validateGuardrailRegexRequestSchema = z
  .object({
    pattern: z
      .string({
        required_error: "pattern is required",
        invalid_type_error: "pattern must be a string",
      })
      .trim()
      .min(1, "pattern cannot be empty")
      .max(1024, "pattern cannot exceed 1024 characters"),
    flags: z
      .string()
      .optional()
      .default("")
      .refine(
        (val) => {
          if (!val) return true;
          const chars = val.split("");
          const seen = new Set<string>();
          for (const ch of chars) {
            if (!VALID_REGEX_FLAGS.has(ch) || seen.has(ch)) {
              return false;
            }
            seen.add(ch);
          }
          return true;
        },
        {
          message: "flags must contain unique valid RegExp flags (d, g, i, m, s, u, v, y)",
        },
      ),
    testInputs: z
      .array(z.string().max(2000, "testInput cannot exceed 2000 characters"))
      .max(50, "cannot provide more than 50 test inputs")
      .optional(),
  })
  .strict();

export type GuardrailRegexValidationRequest = z.infer<
  typeof validateGuardrailRegexRequestSchema
>;

/**
 * Static heuristic analysis for catastrophic backtracking (ReDoS) patterns.
 */
export function analyzeReDoSRisk(
  pattern: string,
  flags = "",
): {
  valid: boolean;
  redosRisk: boolean;
  riskReason?: string;
  complexity: GuardrailRegexComplexity;
  error?: string;
} {
  // 1. Syntax check
  try {
    new RegExp(pattern, flags);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      valid: false,
      redosRisk: false,
      complexity: "vulnerable",
      error: message,
    };
  }

  const reasons: string[] = [];

  // 2. Nested quantifiers heuristic: (group+)+ or (group*)* or (group{n,})+
  const nestedQuantifiers = /\((?:[^()\\]|\\.)*([*+]|\{\d+,?\d*\})(?:[^()\\]|\\.)*\)([*+]|\{\d+,?\d*\})/;
  if (nestedQuantifiers.test(pattern)) {
    reasons.push("Nested quantifiers detected (e.g. (a+)+ or (x*)*)");
  }

  // 3. Overlapping alternation in repeated groups: (a|a)+, (a|ab)+
  const repeatedGroupWithAlternation = /\(((?:[^()\\]|\\.)*\|(?:[^()\\]|\\.)*)\)([*+]|\{\d+,?\d*\})/;
  const altMatch = pattern.match(repeatedGroupWithAlternation);
  if (altMatch) {
    const rawBranches = altMatch[1].split("|").map((s) => s.trim());
    const uniqueBranches = new Set(rawBranches);
    if (uniqueBranches.size < rawBranches.length) {
      reasons.push("Duplicate alternatives in repeated group");
    } else if (
      rawBranches.some((a, i) =>
        rawBranches.some(
          (b, j) =>
            i !== j &&
            a.length > 0 &&
            b.length > 0 &&
            (a.startsWith(b) || b.startsWith(a)),
        ),
      )
    ) {
      reasons.push("Overlapping alternatives in repeated group (e.g. (a|ab)+)");
    }
  }

  // 4. Adjacent unconstrained wildcards: .*.* or .+.+
  if (/(\.\*|\.\+){2,}/.test(pattern)) {
    reasons.push("Adjacent unconstrained wildcards (e.g. .*.*)");
  }

  // 5. Dynamic probe execution against common worst-case trigger strings
  try {
    const re = new RegExp(pattern);
    const probes = [
      "a".repeat(25) + "!",
      "0".repeat(25) + "!",
      "x".repeat(25) + "!",
      " ".repeat(25) + "!",
      "a".repeat(30),
      "abc".repeat(10) + "!",
    ];

    for (const probe of probes) {
      const t0 = performance.now();
      re.test(probe);
      const elapsed = performance.now() - t0;
      if (elapsed > 15) {
        reasons.push(`Catastrophic backtracking observed (${elapsed.toFixed(1)}ms on probe)`);
        break;
      }
    }
  } catch {
    // If testing throws, keep static reasons
  }

  const redosRisk = reasons.length > 0;
  let complexity: GuardrailRegexComplexity = "safe";

  if (redosRisk) {
    complexity = reasons.some(
      (r) => r.includes("Nested") || r.includes("backtracking") || r.includes("Duplicate"),
    )
      ? "vulnerable"
      : "high";
  } else if (pattern.length > 256 || /[+*]{2,}/.test(pattern)) {
    complexity = "medium";
  } else if (/[+*?]|\{\d+,?\d*\}/.test(pattern)) {
    complexity = "low";
  } else {
    complexity = "safe";
  }

  return {
    valid: true,
    redosRisk,
    riskReason: redosRisk ? reasons.join("; ") : undefined,
    complexity,
  };
}

/**
 * Validates a guardrail regex pattern and optionally executes test samples.
 */
export function validateGuardrailRegex(
  input: GuardrailRegexValidationRequest,
): GuardrailRegexValidationResult {
  const pattern = input.pattern;
  const flags = input.flags || "";

  const analysis = analyzeReDoSRisk(pattern, flags);

  if (!analysis.valid) {
    return {
      valid: false,
      pattern,
      flags,
      redosRisk: false,
      complexity: "vulnerable",
      error: analysis.error,
    };
  }

  let sampleMatches: GuardrailRegexSampleMatch[] | undefined;

  if (input.testInputs && input.testInputs.length > 0) {
    sampleMatches = [];
    try {
      const re = new RegExp(pattern, flags);
      for (const sample of input.testInputs) {
        try {
          const matched = re.test(sample);
          sampleMatches.push({ input: sample, matched });
        } catch (sampleErr: unknown) {
          const sampleMsg =
            sampleErr instanceof Error ? sampleErr.message : String(sampleErr);
          sampleMatches.push({ input: sample, matched: false, error: sampleMsg });
        }
      }
    } catch (reErr: unknown) {
      const reMsg = reErr instanceof Error ? reErr.message : String(reErr);
      return {
        valid: false,
        pattern,
        flags,
        redosRisk: false,
        complexity: "vulnerable",
        error: reMsg,
      };
    }
  }

  return {
    valid: true,
    pattern,
    flags,
    redosRisk: analysis.redosRisk,
    riskReason: analysis.riskReason,
    complexity: analysis.complexity,
    sampleMatches,
  };
}
