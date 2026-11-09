import { describe, expect, it } from "vitest";
import type { PullRequestHeadLaneEvidence } from "../../services/github-pull-request-ci.js";
import {
  SELF_CHECK_EVIDENCE_MAX_AGE_MS,
  SELF_CHECK_EVIDENCE_STATES,
  isSelfCheckEvidenceAdmissible,
  readSelfCheckEvidence,
  selfCheckEvidenceToGateInput,
  type SelfCheckEvidenceDeps,
  type SelfCheckEvidencePullRequestDetails,
  type SelfCheckEvidencePullRequestTarget,
} from "./evidence.js";
import { evaluateSelfCheckGate, SELF_CHECK_REJECT_CODES } from "./domain.js";

const HEAD = "42c79c5da4327601f290f72623c4fa0dbb3e4eb8";
const OTHER_HEAD = "9f1d2c3b4a5e6f708192a3b4c5d6e7f8091a2b3c";
const NOW = new Date("2026-11-07T12:00:00.000Z");

function lane(
  laneName: "test" | "lint",
  overrides: Partial<PullRequestHeadLaneEvidence> = {},
): PullRequestHeadLaneEvidence {
  return {
    lane: laneName,
    name: laneName,
    headSha: HEAD,
    state: "success",
    status: "completed",
    conclusion: "success",
    finishedAt: new Date(NOW.getTime() - 5 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

const greenDetails: SelfCheckEvidencePullRequestDetails = {
  headSha: HEAD,
  changedFiles: 3,
  additions: 120,
  deletions: 14,
};

const openTarget: SelfCheckEvidencePullRequestTarget = {
  kind: "ok",
  pullRequestUrl: "https://github.com/acme/app/pull/42",
  reference: { host: "github.com", owner: "acme", repo: "app", number: 42 },
};

function deps(overrides: Partial<SelfCheckEvidenceDeps> = {}): SelfCheckEvidenceDeps {
  return {
    resolvePullRequestTarget: async () => openTarget,
    resolvePullRequestDetails: async () => greenDetails,
    resolveHeadLaneEvidence: async () => [lane("test"), lane("lint")],
    ...overrides,
  };
}

function read(overrides: Partial<SelfCheckEvidenceDeps> = {}) {
  return readSelfCheckEvidence(
    { companyId: "company-1", issueId: "issue-1", evaluatedAt: NOW },
    deps(overrides),
  );
}

describe("readSelfCheckEvidence", () => {
  // Требование задачи: нет PR → no_pr
  it("нет PR → no_pr", async () => {
    const evidence = await read({ resolvePullRequestTarget: async () => ({ kind: "none" }) });
    expect(evidence.status).toBe(SELF_CHECK_EVIDENCE_STATES.NO_PULL_REQUEST);
    expect(evidence.status).not.toBe(SELF_CHECK_EVIDENCE_STATES.OK);
    expect(evidence.pullRequest).toBeNull();
    expect(evidence.headSha).toBeNull();
    expect(isSelfCheckEvidenceAdmissible(evidence)).toBe(false);
    expect(selfCheckEvidenceToGateInput(evidence)).toBeNull();
  });

  // Требование задачи: CI pending → pending
  it("CI pending → pending", async () => {
    const evidence = await read({
      resolveHeadLaneEvidence: async () => [
        lane("test", { state: "pending", status: "in_progress", conclusion: null, finishedAt: null }),
        lane("lint"),
      ],
    });
    expect(evidence.status).toBe(SELF_CHECK_EVIDENCE_STATES.PENDING);
    expect(evidence.reason).toBe("lane_pending:test");
    expect(isSelfCheckEvidenceAdmissible(evidence)).toBe(false);
    expect(selfCheckEvidenceToGateInput(evidence)).toBeNull();
  });

  // Требование задачи: результат с чужого head → stale
  it("результат с чужого head → stale", async () => {
    const evidence = await read({
      resolveHeadLaneEvidence: async () => [
        lane("test", { headSha: OTHER_HEAD }),
        lane("lint"),
      ],
    });
    expect(evidence.status).toBe(SELF_CHECK_EVIDENCE_STATES.STALE);
    expect(evidence.reason).toBe("lane_head_mismatch:test");
    expect(isSelfCheckEvidenceAdmissible(evidence)).toBe(false);
    expect(selfCheckEvidenceToGateInput(evidence)).toBeNull();
  });

  // Требование задачи: зелёный на head → ok
  it("зелёный на head → ok", async () => {
    const evidence = await read();
    expect(evidence.status).toBe(SELF_CHECK_EVIDENCE_STATES.OK);
    expect(evidence.reason).toBeNull();
    expect(evidence.headSha).toBe(HEAD);
    expect(evidence.diff).toEqual({ changedFiles: 3, additions: 120, deletions: 14 });
    expect(isSelfCheckEvidenceAdmissible(evidence)).toBe(true);

    const gateInput = selfCheckEvidenceToGateInput(evidence);
    expect(gateInput).not.toBeNull();
    const decision = evaluateSelfCheckGate(gateInput!, { evaluatedAt: NOW });
    expect(decision.kind).toBe("admit");
  });

  it("зелёный, но старше окна → stale и гейт не пускает", async () => {
    const staleFinishedAt = new Date(
      NOW.getTime() - SELF_CHECK_EVIDENCE_MAX_AGE_MS - 60_000,
    ).toISOString();
    const evidence = await read({
      resolveHeadLaneEvidence: async () => [
        lane("test", { finishedAt: staleFinishedAt }),
        lane("lint"),
      ],
    });
    expect(evidence.status).toBe(SELF_CHECK_EVIDENCE_STATES.STALE);
    expect(evidence.reason).toBe("lane_older_than_window:test");
    expect(selfCheckEvidenceToGateInput(evidence)).toBeNull();
  });

  it("зелёный без времени завершения не считается свежим", async () => {
    const evidence = await read({
      resolveHeadLaneEvidence: async () => [lane("test", { finishedAt: null }), lane("lint")],
    });
    expect(evidence.status).toBe(SELF_CHECK_EVIDENCE_STATES.STALE);
    expect(evidence.reason).toBe("lane_without_finished_at:test");
  });

  it("отсутствующая lane → pending, а не зелёный", async () => {
    const evidence = await read({ resolveHeadLaneEvidence: async () => [lane("test")] });
    expect(evidence.status).toBe(SELF_CHECK_EVIDENCE_STATES.PENDING);
    expect(evidence.reason).toBe("lane_missing:lint");
    expect(isSelfCheckEvidenceAdmissible(evidence)).toBe(false);
  });

  it("lane со state missing → pending", async () => {
    const evidence = await read({
      resolveHeadLaneEvidence: async () => [
        lane("test"),
        lane("lint", { state: "missing", status: "missing", conclusion: null, finishedAt: null }),
      ],
    });
    expect(evidence.status).toBe(SELF_CHECK_EVIDENCE_STATES.PENDING);
    expect(evidence.reason).toBe("lane_missing:lint");
  });

  it("красная lane на текущем head → failed, гейт называет код TEST_FAILED", async () => {
    const evidence = await read({
      resolveHeadLaneEvidence: async () => [
        lane("test", { state: "failure", conclusion: "failure" }),
        lane("lint"),
      ],
    });
    expect(evidence.status).toBe(SELF_CHECK_EVIDENCE_STATES.FAILED);
    expect(evidence.reason).toBe("lane_failed:test");
    expect(isSelfCheckEvidenceAdmissible(evidence)).toBe(false);

    const gateInput = selfCheckEvidenceToGateInput(evidence);
    expect(gateInput).not.toBeNull();
    const decision = evaluateSelfCheckGate(gateInput!, { evaluatedAt: NOW });
    expect(decision.kind).toBe("reject");
    if (decision.kind === "reject") {
      expect(decision.code).toBe(SELF_CHECK_REJECT_CODES.TEST_FAILED);
    }
  });

  it("красная lint-lane → failed с кодом LINT_FAILED", async () => {
    const evidence = await read({
      resolveHeadLaneEvidence: async () => [
        lane("test"),
        lane("lint", { state: "failure", conclusion: "failure" }),
      ],
    });
    expect(evidence.status).toBe(SELF_CHECK_EVIDENCE_STATES.FAILED);
    const gateInput = selfCheckEvidenceToGateInput(evidence);
    const decision = evaluateSelfCheckGate(gateInput!, { evaluatedAt: NOW });
    if (decision.kind === "reject") {
      expect(decision.code).toBe(SELF_CHECK_REJECT_CODES.LINT_FAILED);
    } else {
      throw new Error("expected reject");
    }
  });

  // «Ложно, если unknown-CI трактован как зелёный»
  it("unknown-CI (lane unknown) не трактуется как зелёный", async () => {
    const evidence = await read({
      resolveHeadLaneEvidence: async () => [
        lane("test", { state: "unknown", status: "unknown", conclusion: null, finishedAt: null }),
        lane("lint"),
      ],
    });
    expect(evidence.status).toBe(SELF_CHECK_EVIDENCE_STATES.UNKNOWN);
    expect(evidence.status).not.toBe(SELF_CHECK_EVIDENCE_STATES.OK);
    expect(isSelfCheckEvidenceAdmissible(evidence)).toBe(false);
    expect(selfCheckEvidenceToGateInput(evidence)).toBeNull();
  });

  it("падение резолвера CI → unknown, не зелёный и без throw", async () => {
    const evidence = await read({
      resolveHeadLaneEvidence: async () => {
        throw new Error("checks unavailable");
      },
    });
    expect(evidence.status).toBe(SELF_CHECK_EVIDENCE_STATES.UNKNOWN);
    expect(evidence.reason).toBe("ci_lanes_read_failed");
    expect(isSelfCheckEvidenceAdmissible(evidence)).toBe(false);
  });

  it("падение резолвера PR → unknown, не зелёный", async () => {
    const evidence = await read({
      resolvePullRequestTarget: async () => {
        throw new Error("db down");
      },
    });
    expect(evidence.status).toBe(SELF_CHECK_EVIDENCE_STATES.UNKNOWN);
    expect(isSelfCheckEvidenceAdmissible(evidence)).toBe(false);
  });

  it("нечитаемая ссылка PR → unknown", async () => {
    const evidence = await read({
      resolvePullRequestTarget: async () => ({ kind: "unreadable", pullRequestUrl: "not a pr" }),
    });
    expect(evidence.status).toBe(SELF_CHECK_EVIDENCE_STATES.UNKNOWN);
    expect(evidence.reason).toBe("pull_request_reference_unreadable");
    expect(selfCheckEvidenceToGateInput(evidence)).toBeNull();
  });

  it("нечитаемый head PR → unknown", async () => {
    const evidence = await read({
      resolvePullRequestDetails: async () => ({
        headSha: null,
        changedFiles: 1,
        additions: 2,
        deletions: 3,
      }),
    });
    expect(evidence.status).toBe(SELF_CHECK_EVIDENCE_STATES.UNKNOWN);
    expect(evidence.reason).toBe("pull_request_head_unreadable");
    expect(selfCheckEvidenceToGateInput(evidence)).toBeNull();
  });

  it("отсутствующие счётчики диффа → гейт не пускает (EMPTY_DIFF)", async () => {
    const evidence = await read({
      resolvePullRequestDetails: async () => ({ headSha: HEAD }),
    });
    expect(evidence.status).toBe(SELF_CHECK_EVIDENCE_STATES.OK);
    expect(evidence.diff).toBeNull();
    expect(isSelfCheckEvidenceAdmissible(evidence)).toBe(false);
    expect(selfCheckEvidenceToGateInput(evidence)).toBeNull();
  });

  it("пустой дифф на зелёных lane → гейт отклоняет EMPTY_DIFF", async () => {
    const evidence = await read({
      resolvePullRequestDetails: async () => ({
        headSha: HEAD,
        changedFiles: 0,
        additions: 0,
        deletions: 0,
      }),
    });
    const gateInput = selfCheckEvidenceToGateInput(evidence);
    expect(gateInput).not.toBeNull();
    const decision = evaluateSelfCheckGate(gateInput!, { evaluatedAt: NOW });
    expect(decision.kind).toBe("reject");
    if (decision.kind === "reject") {
      expect(decision.code).toBe(SELF_CHECK_REJECT_CODES.EMPTY_DIFF);
    }
  });

  it("окно свежести настраивается и 0 отключает проверку возраста", async () => {
    const oldFinishedAt = new Date(NOW.getTime() - 3 * 60 * 60 * 1000).toISOString();
    const evidence = await readSelfCheckEvidence(
      { companyId: "company-1", issueId: "issue-1", evaluatedAt: NOW, maxAgeMs: 0 },
      deps({
        resolveHeadLaneEvidence: async () => [
          lane("test", { finishedAt: oldFinishedAt }),
          lane("lint", { finishedAt: oldFinishedAt }),
        ],
      }),
    );
    expect(evidence.status).toBe(SELF_CHECK_EVIDENCE_STATES.OK);
  });

  it("не зовёт сеть и не создаёт клиентов — только инъектированные резолверы", async () => {
    const calls: string[] = [];
    await readSelfCheckEvidence(
      { companyId: "company-1", issueId: "issue-1", evaluatedAt: NOW },
      {
        resolvePullRequestTarget: async () => {
          calls.push("target");
          return openTarget;
        },
        resolvePullRequestDetails: async () => {
          calls.push("details");
          return greenDetails;
        },
        resolveHeadLaneEvidence: async () => {
          calls.push("lanes");
          return [lane("test"), lane("lint")];
        },
      },
    );
    expect(calls).toEqual(["target", "details", "lanes"]);
  });
});
