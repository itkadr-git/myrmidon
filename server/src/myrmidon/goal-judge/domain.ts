// server/src/myrmidon/goal-judge/domain.ts
//
// myrmidon(1.7-GOAL-JUDGE): pure domain logic for goal achievement judge.
//
// Evaluates whether task criteria are satisfied based on git diff and test output.
// Rule: «заявлено, но не проверено = не сделано» (claimed, but not verified = not done).
// Strict JSON parsing, round limits (MAX_ROUNDS=3), and invariant enforcement:
// complete=true is forbidden if missing is non-empty.

import { buildGoalJudgeRetryPrompt, buildGoalJudgeUserPrompt } from "./prompts.js";

/** Maximum number of evaluation rounds permitted for the goal judge. */
export const MAX_ROUNDS = 3;

/** Canonical rule text. */
export const RULE_CLAIMED_NOT_VERIFIED = "заявлено, но не проверено = не сделано";

/** The parsed and validated outcome from the goal judge. */
export interface GoalJudgeVerdict {
  /** Confidence or completion score, typically 0.0 to 1.0 (or 0 to 100). */
  score: number;
  /** True only if ALL criteria are proven with evidence and missing is empty. */
  complete: boolean;
  /** List of unmet or unverified criteria. */
  missing: string[];
  /** Optional summary or explanation. */
  summary?: string;
}

/** Input passed to the goal judge for evaluation. */
export interface GoalJudgeInput {
  /** Acceptance criteria or task objectives. */
  criteria: string[] | string;
  /** The unified diff of changes made. */
  diff?: string | null;
  /** The captured stdout/stderr from test suite execution. */
  testOutput?: string | null;
  /** Optional claims made by the agent about what was completed. */
  claims?: string[] | string | null;
}

/** Result of parsing raw model output into a verdict. */
export interface GoalJudgeParseResult {
  ok: boolean;
  verdict?: GoalJudgeVerdict;
  error?: string;
}

/** Record of a single evaluation round. */
export interface GoalJudgeRoundResult {
  roundNumber: number;
  success: boolean;
  verdict?: GoalJudgeVerdict;
  error?: string;
  rawResponse?: string;
}

/**
 * Validates a candidate verdict against domain invariants.
 *
 * Invariant 1: complete CANNOT be true if missing contains any items.
 * Invariant 2: score must be a finite non-negative number.
 * Invariant 3: missing must be an array of strings.
 */
export function validateGoalJudgeVerdict(value: unknown): { valid: boolean; error?: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { valid: false, error: "Verdict must be a JSON object" };
  }

  const obj = value as Record<string, unknown>;

  if (typeof obj.score !== "number" || !Number.isFinite(obj.score) || obj.score < 0) {
    return { valid: false, error: "Field 'score' must be a non-negative finite number" };
  }

  if (typeof obj.complete !== "boolean") {
    return { valid: false, error: "Field 'complete' must be a boolean" };
  }

  if (!Array.isArray(obj.missing)) {
    return { valid: false, error: "Field 'missing' must be an array of strings" };
  }

  for (let i = 0; i < obj.missing.length; i++) {
    if (typeof obj.missing[i] !== "string") {
      return { valid: false, error: `Field 'missing[${i}]' must be a string` };
    }
  }

  // Core domain invariant: complete=true with non-empty missing is INVALID.
  if (obj.complete === true && obj.missing.length > 0) {
    return {
      valid: false,
      error: "Invariant violation: complete cannot be true when missing has items",
    };
  }

  return { valid: true };
}

/**
 * Parses raw LLM text into a GoalJudgeVerdict.
 *
 * Requires strict JSON. Does not accept arbitrary conversational non-JSON text.
 * Tolerate surrounding markdown code fences (```json ... ```) only when the contents
 * are valid JSON matching the schema and invariants.
 */
export function parseGoalJudgeResponse(raw: string): GoalJudgeParseResult {
  if (typeof raw !== "string") {
    return { ok: false, error: "Input must be a string" };
  }

  let text = raw.trim();
  if (text.length === 0) {
    return { ok: false, error: "Empty response: expected JSON object" };
  }

  // Strip optional markdown code fence if present
  const fenceMatch = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
  if (fenceMatch) {
    text = fenceMatch[1]!.trim();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return {
      ok: false,
      error: `Non-JSON response: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const validation = validateGoalJudgeVerdict(parsed);
  if (!validation.valid) {
    return { ok: false, error: validation.error };
  }

  const record = parsed as {
    score: number;
    complete: boolean;
    missing: string[];
    summary?: unknown;
  };

  return {
    ok: true,
    verdict: {
      score: record.score,
      complete: record.complete,
      missing: record.missing,
      summary: typeof record.summary === "string" ? record.summary : undefined,
    },
  };
}

/**
 * Normalizes criteria input into an array of distinct criterion strings.
 */
export function normalizeCriteria(input: string[] | string): string[] {
  if (Array.isArray(input)) {
    return input.map((s) => s.trim()).filter((s) => s.length > 0);
  }
  return input
    .split(/\r?\n/)
    .map((line) => line.replace(/^[\s*\-•\d.)\]]+/, "").trim())
    .filter((line) => line.length > 0);
}

const COMMON_STOPWORDS = new Set([
  // English common words & schema keywords
  "criterion",
  "criteria",
  "task",
  "item",
  "check",
  "checks",
  "verify",
  "verified",
  "verification",
  "test",
  "tests",
  "testing",
  "code",
  "added",
  "implemented",
  "done",
  "with",
  "from",
  "that",
  "this",
  "have",
  "make",
  "should",
  "must",
  "need",
  "needs",
  "will",
  "would",
  "could",
  "also",
  "into",
  "then",
  "when",
  "what",
  "which",
  "where",
  "been",
  "being",
  "were",
  "they",
  "them",
  "their",
  "about",
  "above",
  "after",
  "again",
  "against",
  // connectives & auxiliaries (never constitute evidence on their own)
  "and",
  "the",
  "for",
  "not",
  "all",
  "any",
  "are",
  "was",
  "has",
  "more",
  "most",
  "some",
  "such",
  "only",
  "same",
  "than",
  "too",
  "very",
  "just",
  "even",
  "add",
  "adds",
  "create",
  "creates",
  "update",
  "updates",
  "delete",
  "deletes",
  "change",
  "changes",
  "remove",
  "removes",
  "ensure",
  "ensures",
  "true",
  "false",
  "score",
  "complete",
  "missing",
  "summary",
  "json",
  "system",
  "user",
  "round",
  "rounds",
  // Russian common words & schema keywords
  "задача",
  "задачи",
  "критерий",
  "критерии",
  "критерия",
  "пункт",
  "пункты",
  "проверка",
  "проверки",
  "проверен",
  "проверено",
  "проверены",
  "проверить",
  "тест",
  "тесты",
  "тестов",
  "тестирование",
  "код",
  "кода",
  "сделано",
  "добавлено",
  "реализовано",
  "это",
  "этот",
  "эта",
  "эти",
  "для",
  "при",
  "как",
  "так",
  "что",
  "чтобы",
  "быть",
  "был",
  "была",
  "было",
  "были",
  "будет",
  "будут",
  "если",
  "или",
  "все",
  "всё",
  "всех",
  "только",
  "тоже",
  "также",
  "после",
  "через",
  "один",
  "одна",
  "одно",
  "одного",
  "свой",
  "свои",
  "своих",
  "нужно",
  "надо",
  "должен",
  "должна",
  "должно",
  "должны",
  "нет",
  "есть",
  "без",
  "под",
  "над",
]);

/**
 * Extracts searchable keywords / identifiers from a criterion text.
 * Supports Unicode letters (Latin, Cyrillic, etc.) via \p{L}.
 */
export function extractCriterionKeywords(criterion: string): string[] {
  // Extract identifiers inside backticks verbatim (e.g. `GoalJudgeSession`)
  const backtickMatches =
    criterion.match(/`([^`]+)`/g)?.map((s) => s.slice(1, -1).trim()).filter((s) => s.length > 0) ?? [];

  // Extract Unicode word tokens (letters, digits, underscores, dashes, dots)
  // \p{L} matches any Unicode letter (including Russian / Cyrillic)
  const tokens = criterion
    .toLowerCase()
    .replace(/[^\p{L}0-9_.\\-]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !COMMON_STOPWORDS.has(w));

  const unique = Array.from(new Set([...backtickMatches, ...tokens]));
  return unique;
}

/**
 * Checks if a candidate keyword exists in target text as a distinct word token
 * or bounded identifier, preventing accidental substring false-positives.
 */
function matchesKeyword(text: string, kw: string): boolean {
  const kwLower = kw.toLowerCase();
  const textLower = text.toLowerCase();

  // If keyword contains non-alphanumeric punctuation (like a symbol, dot, or dash), match escaped
  const escaped = kwLower.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Bounded by non-word/non-letter characters (Unicode aware)
  const pattern = new RegExp(`(^|[^\\p{L}0-9_])${escaped}([^\\p{L}0-9_]|$)`, "u");
  return pattern.test(textLower);
}

/**
 * Evaluates whether diff and test output provide verifiable proof for a criterion.
 * Rule: «заявлено, но не проверено = не сделано».
 */
export function hasEvidenceForCriterion(
  criterion: string,
  diff?: string | null,
  testOutput?: string | null,
): boolean {
  const diffText = (diff ?? "").trim();
  const testText = (testOutput ?? "").trim();

  // If both diff and test output are empty, there is zero proof.
  if (diffText.length === 0 && testText.length === 0) {
    return false;
  }

  // Check test output:
  // 1. Failing tests disqualify proof: e.g. "1 failed", "FAIL", "failing", "error during test run"
  const hasFailingTests =
    /\b(FAIL|failing|error during test run)\b/i.test(testText) ||
    /\b[1-9]\d*\s+failed\b/i.test(testText);

  if (hasFailingTests) {
    return false;
  }

  // 2. Skipped-only tests do not prove anything, even if diff is present
  const testsSkippedOnly =
    /\b(SKIPPED|all tests skipped|0 passed)\b/i.test(testText) &&
    !/\b[1-9]\d*\s+passed\b/i.test(testText);

  if (testsSkippedOnly && testText.length > 0) {
    return false;
  }

  const backtickMatches = new Set(
    criterion.match(/`([^`]+)`/g)?.map((s) => s.slice(1, -1).toLowerCase().trim()) ?? []
  );

  const keywords = extractCriterionKeywords(criterion);
  // If no keywords could be extracted from the criterion, we have no proof (cannot verify).
  if (keywords.length === 0) {
    return false;
  }

  const matchedKeywords = new Set(
    keywords.filter(
      (kw) =>
        (diffText.length > 0 && matchesKeyword(diffText, kw)) ||
        (testText.length > 0 && matchesKeyword(testText, kw)),
    ),
  );

  // Strict evidence threshold:
  // If there is only 1 keyword, it must be explicitly quoted in backticks OR match in both diff AND testOutput.
  // If there are multiple keywords, require at least 2 distinct matching keywords to prevent single-word false positives.
  if (keywords.length === 1) {
    const singleKw = keywords[0]!;
    const isBacktick = backtickMatches.has(singleKw);
    const matchedInBoth = diffText.length > 0 && testText.length > 0 && matchesKeyword(diffText, singleKw) && matchesKeyword(testText, singleKw);
    return isBacktick || matchedInBoth;
  }

  const requiredMatches = Math.min(2, keywords.length);
  return matchedKeywords.size >= requiredMatches;
}

/**
 * Applies the rule «заявлено, но не проверено = не сделано».
 *
 * Inspects all criteria and claims. Any criterion claimed or expected that lacks
 * verifiable proof in the diff or test output is added to `missing`, and `complete`
 * is guaranteed to be false.
 */
export function applyUnverifiedRule(
  verdict: GoalJudgeVerdict,
  input: GoalJudgeInput,
): GoalJudgeVerdict {
  // The evidence scan exists to veto an unproven complete=true («заявлено, но
  // не проверено = не сделано»). When the judge already returned complete=false,
  // its missing list is authoritative: re-running the keyword heuristic here
  // appended the raw criteria on top of the judge's paraphrases (2 -> 5 items)
  // and zeroed the score, corrupting the very report the executor receives.
  if (!verdict.complete) {
    return verdict;
  }
  const criteria = normalizeCriteria(input.criteria);
  const claims = input.claims ? normalizeCriteria(input.claims) : [];
  const candidateItems = Array.from(new Set([...criteria, ...claims]));

  const missingSet = new Set(verdict.missing);

  for (const item of candidateItems) {
    const verified = hasEvidenceForCriterion(item, input.diff, input.testOutput);
    if (!verified) {
      // Rule: criterion without proof in diff or tests must be in missing!
      if (!missingSet.has(item)) {
        missingSet.add(item);
      }
    }
  }

  const missing = Array.from(missingSet);
  const complete = missing.length === 0 ? verdict.complete : false;
  let score = verdict.score;

  if (missing.length > 0) {
    const penaltyRatio = missing.length / Math.max(candidateItems.length, 1);
    // If there are missing items, complete is false and score is penalized proportionally
    if (score <= 1.0) {
      score = Math.max(0, Math.min(score, 1.0 - penaltyRatio));
    } else {
      score = Math.max(0, Math.min(score, Math.round(100 - penaltyRatio * 100)));
    }
  }

  return {
    ...verdict,
    score,
    complete,
    missing,
  };
}

/**
 * Round controller / session for managing up to MAX_ROUNDS goal judge evaluations.
 */
export class GoalJudgeSession {
  readonly maxRounds: number;
  currentRound: number;
  rounds: GoalJudgeRoundResult[];
  isComplete: boolean;
  finalVerdict: GoalJudgeVerdict | null;

  constructor(options?: { maxRounds?: number }) {
    this.maxRounds = options?.maxRounds ?? MAX_ROUNDS;
    this.currentRound = 0;
    this.rounds = [];
    this.isComplete = false;
    this.finalVerdict = null;
  }

  /** True if additional evaluation rounds are allowed. */
  canContinue(): boolean {
    return !this.isComplete && this.currentRound < this.maxRounds;
  }

  /**
   * Processes a single round's raw response.
   *
   * Crucial: non-JSON responses do NOT throw process exceptions.
   * They are recorded as round errors with success=false.
   */
  step(rawResponse: string, input?: GoalJudgeInput): GoalJudgeRoundResult {
    if (this.currentRound >= this.maxRounds) {
      const exhaustedResult: GoalJudgeRoundResult = {
        roundNumber: this.currentRound,
        success: false,
        error: `Max rounds limit reached (${this.maxRounds})`,
        rawResponse,
      };
      return exhaustedResult;
    }

    this.currentRound++;

    const parseResult = parseGoalJudgeResponse(rawResponse);
    if (!parseResult.ok || !parseResult.verdict) {
      const roundErrorResult: GoalJudgeRoundResult = {
        roundNumber: this.currentRound,
        success: false,
        error: parseResult.error ?? "Failed to parse judge response",
        rawResponse,
      };
      this.rounds.push(roundErrorResult);
      return roundErrorResult;
    }

    let verdict = parseResult.verdict;
    if (input) {
      verdict = applyUnverifiedRule(verdict, input);
    }

    const roundResult: GoalJudgeRoundResult = {
      roundNumber: this.currentRound,
      success: true,
      verdict,
      rawResponse,
    };
    this.rounds.push(roundResult);

    if (verdict.complete) {
      this.isComplete = true;
      this.finalVerdict = verdict;
    } else if (this.currentRound >= this.maxRounds) {
      this.finalVerdict = verdict;
    }

    return roundResult;
  }
}

/**
 * Runs a multi-round goal judge evaluation loop up to MAX_ROUNDS.
 */
export async function runGoalJudgeRounds(
  input: GoalJudgeInput,
  callModel: (prompt: string, round: number) => Promise<string>,
  options?: { maxRounds?: number; buildPrompt?: (round: number, lastError?: string) => string },
): Promise<{ session: GoalJudgeSession; verdict: GoalJudgeVerdict | null }> {
  const session = new GoalJudgeSession(options);
  let lastError: string | undefined;

  while (session.canContinue()) {
    const nextRound = session.currentRound + 1;
    let prompt: string;
    if (options?.buildPrompt) {
      prompt = options.buildPrompt(nextRound, lastError);
    } else if (lastError && nextRound > 1) {
      prompt = buildGoalJudgeRetryPrompt(lastError, nextRound);
    } else {
      prompt = buildGoalJudgeUserPrompt(input, {
        round: nextRound,
        maxRounds: session.maxRounds,
        previousFeedback: lastError,
      });
    }

    let response: string;
    try {
      response = await callModel(prompt, nextRound);
    } catch (err) {
      // Model call failure is treated as a round error, not an unhandled process crash
      const roundResult: GoalJudgeRoundResult = {
        roundNumber: nextRound,
        success: false,
        error: `Model invocation failed: ${err instanceof Error ? err.message : String(err)}`,
      };
      session.currentRound++;
      session.rounds.push(roundResult);
      lastError = roundResult.error;
      continue;
    }

    const result = session.step(response, input);
    if (result.success && result.verdict?.complete) {
      break;
    }
    lastError = result.error ?? result.verdict?.missing.join("; ");
  }

  return { session, verdict: session.finalVerdict };
}
