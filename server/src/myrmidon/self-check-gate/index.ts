export * from "./domain.js";
export * from "./policy.js";
export * from "./evidence.js";

import type { Db } from "@myrmidon/db";
import {
  evaluateSelfCheckGate,
  isMyrmidonDiffEmpty,
  rejectSelfCheckGate,
  SELF_CHECK_REJECT_CODES,
  type SelfCheckGateDecision,
} from "./domain.js";
import {
  readSelfCheckEvidence,
  selfCheckEvidenceToGateInput,
  SELF_CHECK_EVIDENCE_STATES,
  type SelfCheckEvidence,
  type SelfCheckEvidenceDeps,
} from "./evidence.js";
import { loadIssuePullRequestTarget } from "../review-stage-recovery/github-ci.js";
import { createPullRequestMergeDetailsResolver } from "../../services/github-pull-request-merge.js";
import {
  createPullRequestCiResolver,
  summarizeHeadLaneEvidence,
} from "../../services/github-pull-request-ci.js";

export const DEFAULT_MAX_TECHNICAL_REJECTIONS = 3;

export type SelfCheckGateResolver = (input: {
  companyId: string;
  issueId: string;
}) => Promise<SelfCheckGateDecision>;

export function evaluateSelfCheckEvidence(
  evidence: SelfCheckEvidence,
): SelfCheckGateDecision {
  if (evidence.status === SELF_CHECK_EVIDENCE_STATES.NO_PULL_REQUEST) {
    return rejectSelfCheckGate(
      SELF_CHECK_REJECT_CODES.EMPTY_DIFF,
      "[EMPTY_DIFF] Отсутствует pull request: нет изменений для проверки перед переходом в in_review.",
    );
  }
  if (evidence.status === SELF_CHECK_EVIDENCE_STATES.PENDING) {
    return rejectSelfCheckGate(
      SELF_CHECK_REJECT_CODES.TEST_FAILED,
      `[TEST_FAILED] CI проверки ещё выполняются (${evidence.reason ?? "pending"}). Дождитесь завершения проверок перед переходом в in_review.`,
    );
  }
  if (evidence.status === SELF_CHECK_EVIDENCE_STATES.STALE) {
    const code = evidence.reason?.includes("lint")
      ? SELF_CHECK_REJECT_CODES.STALE_LINT
      : SELF_CHECK_REJECT_CODES.STALE_TEST;
    return rejectSelfCheckGate(
      code,
      `[${code}] Результаты проверок устарели (${evidence.reason ?? "stale"}). Перезапустите проверки на актуальном коммите перед переходом в in_review.`,
    );
  }
  if (evidence.status === SELF_CHECK_EVIDENCE_STATES.UNKNOWN) {
    return rejectSelfCheckGate(
      SELF_CHECK_REJECT_CODES.TEST_FAILED,
      `[TEST_FAILED] Не удалось получить статус проверок (${evidence.reason ?? "unknown"}).`,
    );
  }

  const gateInput = selfCheckEvidenceToGateInput(evidence);
  if (!gateInput) {
    if (!evidence.diff || isMyrmidonDiffEmpty(evidence.diff)) {
      return rejectSelfCheckGate(SELF_CHECK_REJECT_CODES.EMPTY_DIFF);
    }
    return rejectSelfCheckGate(SELF_CHECK_REJECT_CODES.TEST_FAILED);
  }

  return evaluateSelfCheckGate(gateInput);
}

export function createDefaultSelfCheckEvidenceDeps(
  db: Db,
): SelfCheckEvidenceDeps {
  const prDetailsResolver = createPullRequestMergeDetailsResolver(db);
  const prCiResolver = createPullRequestCiResolver(db, {
    source: "run-context",
  });
  return {
    resolvePullRequestTarget: async ({ companyId, issueId }) =>
      loadIssuePullRequestTarget(db, companyId, issueId),
    resolvePullRequestDetails: async (companyId, reference) =>
      prDetailsResolver(companyId, reference),
    resolveHeadLaneEvidence: async ({ companyId, reference }) => {
      const ciResult = await prCiResolver.resolveForPullRequest(
        companyId,
        reference,
      );
      return summarizeHeadLaneEvidence(ciResult.runs, {
        headSha: ciResult.headSha,
      });
    },
  };
}

export function createSelfCheckGateResolver(deps: {
  db: Db;
  evidenceDeps?: Partial<SelfCheckEvidenceDeps>;
}): SelfCheckGateResolver {
  return async ({ companyId, issueId }) => {
    const defaultDeps = createDefaultSelfCheckEvidenceDeps(deps.db);
    const fullDeps: SelfCheckEvidenceDeps = {
      resolvePullRequestTarget:
        deps.evidenceDeps?.resolvePullRequestTarget ??
        defaultDeps.resolvePullRequestTarget,
      resolvePullRequestDetails:
        deps.evidenceDeps?.resolvePullRequestDetails ??
        defaultDeps.resolvePullRequestDetails,
      resolveHeadLaneEvidence:
        deps.evidenceDeps?.resolveHeadLaneEvidence ??
        defaultDeps.resolveHeadLaneEvidence,
    };
    const evidence = await readSelfCheckEvidence(
      { companyId, issueId },
      fullDeps,
    );
    return evaluateSelfCheckEvidence(evidence);
  };
}
