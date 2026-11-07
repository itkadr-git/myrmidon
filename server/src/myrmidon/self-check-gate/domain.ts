/**
 * myrmidon(SELF-CHECK-GATE): Pure domain for pre-in_review stop-gate.
 *
 * OpenHands SDK ideas adapted for Myrmidon:
 * - In OpenHands hooks, an empty diff is admitted (treated as no-op).
 * - In Myrmidon, an empty diff is strictly forbidden before `in_review` (always rejected).
 * - Requires successful and fresh test and lint check runs against current head SHA.
 *
 * Zero DB, network or process dependencies — pure functions only.
 */

export const SELF_CHECK_REJECT_CODES = {
  EMPTY_DIFF: "EMPTY_DIFF",
  TEST_FAILED: "TEST_FAILED",
  LINT_FAILED: "LINT_FAILED",
  STALE_TEST: "STALE_TEST",
  STALE_LINT: "STALE_LINT",
  TEST_MISSING: "TEST_MISSING",
  LINT_MISSING: "LINT_MISSING",
} as const;

export type SelfCheckRejectCode =
  (typeof SELF_CHECK_REJECT_CODES)[keyof typeof SELF_CHECK_REJECT_CODES];
export type MyrmidonSelfCheckRejectCode = SelfCheckRejectCode;

export interface MyrmidonDiffStats {
  readonly changedFiles: number;
  readonly additions: number;
  readonly deletions: number;
}

export type MyrmidonCheckStatus = "success" | "failure";

export interface MyrmidonRunCheckResult {
  readonly status: MyrmidonCheckStatus | string;
  readonly headSha: string;
  readonly finishedAt?: Date | string | number | null;
}

export interface SelfCheckGateAdmit {
  readonly kind: "admit";
  readonly admitted: true;
}

export interface SelfCheckGateReject {
  readonly kind: "reject";
  readonly admitted: false;
  readonly code: MyrmidonSelfCheckRejectCode;
  readonly message: string;
  readonly reason: string;
}

export type SelfCheckGateDecision = SelfCheckGateAdmit | SelfCheckGateReject;

export const SELF_CHECK_MESSAGES: Record<
  MyrmidonSelfCheckRejectCode,
  (detail?: Record<string, unknown>) => string
> = {
  EMPTY_DIFF: () =>
    "[EMPTY_DIFF] Пустой дифф: в рабочей копии нет изменений (0 изменённых файлов, 0+0 строк). Внесите необходимые изменения в код перед переходом в in_review.",
  TEST_FAILED: () =>
    "[TEST_FAILED] Прогон тестов завершился с ошибкой либо результат не получен. Исправьте ошибки в тестах и убедитесь, что тесты успешно проходят.",
  LINT_FAILED: () =>
    "[LINT_FAILED] Проверка линтера завершилась с ошибкой либо результат не получен. Исправьте ошибки линтинга и убедитесь, что линт проходит без ошибок.",
  STALE_TEST: (detail) => {
    const head = detail?.headSha ? ` (head sha: ${String(detail.headSha)})` : "";
    const expected = detail?.currentHeadSha ? `, ожидается: ${String(detail.currentHeadSha)}` : "";
    return `[STALE_TEST] Результаты тестов устарели${head}${expected}. Перезапустите тесты на актуальном коммите перед переходом в in_review.`;
  },
  STALE_LINT: (detail) => {
    const head = detail?.headSha ? ` (head sha: ${String(detail.headSha)})` : "";
    const expected = detail?.currentHeadSha ? `, ожидается: ${String(detail.currentHeadSha)}` : "";
    return `[STALE_LINT] Результаты линтера устарели${head}${expected}. Перезапустите линтер на актуальном коммите перед переходом в in_review.`;
  },
  TEST_MISSING: () =>
    "[TEST_MISSING] Отсутствует результат прогона тестов. Запустите тесты перед переходом в in_review.",
  LINT_MISSING: () =>
    "[LINT_MISSING] Отсутствует результат проверки линтера. Запустите линтер перед переходом в in_review.",
};

export function admitSelfCheckGate(): SelfCheckGateAdmit {
  return {
    kind: "admit",
    admitted: true,
  };
}

export function rejectSelfCheckGate(
  code: MyrmidonSelfCheckRejectCode,
  customMessage?: string,
  detail?: Record<string, unknown>,
): SelfCheckGateReject {
  const message = customMessage ?? SELF_CHECK_MESSAGES[code](detail);
  return {
    kind: "reject",
    admitted: false,
    code,
    message,
    reason: message,
  };
}

export function isSelfCheckGateAdmitted(
  decision: SelfCheckGateDecision,
): decision is SelfCheckGateAdmit {
  return decision.kind === "admit";
}

export function isMyrmidonDiffEmpty(
  diff: MyrmidonDiffStats | null | undefined,
): boolean {
  if (!diff) return true;
  if (typeof diff.changedFiles !== "number" || diff.changedFiles <= 0) return true;
  const additions = typeof diff.additions === "number" ? diff.additions : 0;
  const deletions = typeof diff.deletions === "number" ? diff.deletions : 0;
  if (additions <= 0 && deletions <= 0) return true;
  return false;
}

export interface FreshnessOptions {
  readonly evaluatedAt?: Date | string | number | null;
  readonly maxAgeMs?: number | null;
  readonly minFinishedAt?: Date | string | number | null;
}

export function isSameCommitSha(
  sha1: string | null | undefined,
  sha2: string | null | undefined,
): boolean {
  if (!sha1 || !sha2) return false;
  const s1 = sha1.trim().toLowerCase();
  const s2 = sha2.trim().toLowerCase();
  if (s1 === s2) return true;
  if (s1.length >= 7 && s2.length >= 7 && (s1.startsWith(s2) || s2.startsWith(s1))) {
    return true;
  }
  return false;
}

export function parseTimestampToMs(
  val: Date | string | number | null | undefined,
): number | null {
  if (val == null) return null;
  if (val instanceof Date) return isNaN(val.getTime()) ? null : val.getTime();
  if (typeof val === "number") return isNaN(val) ? null : val;
  if (typeof val === "string") {
    const ms = Date.parse(val);
    return isNaN(ms) ? null : ms;
  }
  return null;
}

export function isCheckResultStale(
  result: MyrmidonRunCheckResult,
  currentHeadSha: string,
  options?: FreshnessOptions,
): boolean {
  if (!isSameCommitSha(result.headSha, currentHeadSha)) {
    return true;
  }

  if (options) {
    const finishedMs = parseTimestampToMs(result.finishedAt);
    if (finishedMs == null) {
      if (options.minFinishedAt != null || options.maxAgeMs != null) {
        return true;
      }
    } else {
      if (options.minFinishedAt != null) {
        const minMs = parseTimestampToMs(options.minFinishedAt);
        if (minMs != null && finishedMs < minMs) {
          return true;
        }
      }
      if (options.maxAgeMs != null && options.maxAgeMs > 0) {
        const evaluatedMs = parseTimestampToMs(options.evaluatedAt) ?? Date.now();
        if (evaluatedMs - finishedMs > options.maxAgeMs) {
          return true;
        }
      }
    }
  }

  return false;
}

export interface SelfCheckGateInput {
  readonly currentHeadSha?: string;
  readonly headSha?: string;
  readonly diff?: MyrmidonDiffStats | null;
  readonly test?: MyrmidonRunCheckResult | null;
  readonly lint?: MyrmidonRunCheckResult | null;
  readonly evaluatedAt?: Date | string | number | null;
  readonly minFinishedAt?: Date | string | number | null;
  readonly maxAgeMs?: number | null;
}

export interface SelfCheckPolicyOptions extends FreshnessOptions {
  readonly distinguishMissing?: boolean;
}

export class SelfCheckGateError extends Error {
  readonly code: MyrmidonSelfCheckRejectCode;
  readonly decision: SelfCheckGateDecision;

  constructor(decision: SelfCheckGateDecision) {
    const message = decision.kind === "reject" ? decision.message : "Self-check gate admitted";
    super(message);
    this.name = "SelfCheckGateError";
    this.code = decision.kind === "reject" ? decision.code : SELF_CHECK_REJECT_CODES.TEST_FAILED;
    this.decision = decision;
  }
}

export function evaluateSelfCheckGate(
  input: SelfCheckGateInput,
  options?: SelfCheckPolicyOptions,
): SelfCheckGateDecision {
  const currentHeadSha = (input.currentHeadSha ?? input.headSha ?? "").trim();

  // 1. Diff verification: empty diff is always rejected
  if (isMyrmidonDiffEmpty(input.diff)) {
    return rejectSelfCheckGate(
      SELF_CHECK_REJECT_CODES.EMPTY_DIFF,
      undefined,
      { currentHeadSha },
    );
  }

  const freshnessOpts: FreshnessOptions = {
    evaluatedAt: options?.evaluatedAt ?? input.evaluatedAt,
    minFinishedAt: options?.minFinishedAt ?? input.minFinishedAt,
    maxAgeMs: options?.maxAgeMs ?? input.maxAgeMs,
  };

  // 2. Test run verification
  if (!input.test) {
    const code = options?.distinguishMissing
      ? SELF_CHECK_REJECT_CODES.TEST_MISSING
      : SELF_CHECK_REJECT_CODES.TEST_FAILED;
    return rejectSelfCheckGate(code, undefined, { currentHeadSha });
  }

  if (input.test.status !== "success") {
    return rejectSelfCheckGate(
      SELF_CHECK_REJECT_CODES.TEST_FAILED,
      undefined,
      { currentHeadSha, testStatus: input.test.status },
    );
  }

  if (isCheckResultStale(input.test, currentHeadSha, freshnessOpts)) {
    return rejectSelfCheckGate(
      SELF_CHECK_REJECT_CODES.STALE_TEST,
      undefined,
      { currentHeadSha, headSha: input.test.headSha },
    );
  }

  // 3. Lint run verification
  if (!input.lint) {
    const code = options?.distinguishMissing
      ? SELF_CHECK_REJECT_CODES.LINT_MISSING
      : SELF_CHECK_REJECT_CODES.LINT_FAILED;
    return rejectSelfCheckGate(code, undefined, { currentHeadSha });
  }

  if (input.lint.status !== "success") {
    return rejectSelfCheckGate(
      SELF_CHECK_REJECT_CODES.LINT_FAILED,
      undefined,
      { currentHeadSha, lintStatus: input.lint.status },
    );
  }

  if (isCheckResultStale(input.lint, currentHeadSha, freshnessOpts)) {
    return rejectSelfCheckGate(
      SELF_CHECK_REJECT_CODES.STALE_LINT,
      undefined,
      { currentHeadSha, headSha: input.lint.headSha },
    );
  }

  // All checks passed
  return admitSelfCheckGate();
}

export function assertSelfCheckGate(
  input: SelfCheckGateInput,
  options?: SelfCheckPolicyOptions,
): SelfCheckGateAdmit {
  const decision = evaluateSelfCheckGate(input, options);
  if (!decision.admitted) {
    throw new SelfCheckGateError(decision);
  }
  return decision;
}
