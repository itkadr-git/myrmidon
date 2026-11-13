/**
 * VERIFY-ON-PROD release verification gate (OPE-13014).
 *
 * After a deploy, confirm that the deployed version actually contains the
 * merge commits of every issue that belongs to the release candidate. The
 * release must NOT be closed while its composition is unproven.
 *
 * This module deliberately consumes only the public contract of the
 * `release-membership` module (checkCommitMembership / ReleaseMembership) so
 * the integration surface stays narrow. It adds the release-level aggregation
 * the single-PR route does not do: take the full candidate set, check every
 * member against the deployed release refs, and produce a single
 * pass/fail verdict with an explicit reason.
 *
 * Empty or incomplete candidate lists are NOT a success: a release with zero
 * proven members fails closed with `empty_candidate_set`, and any member that
 * is missing or unresolvable fails the whole release with a named reason.
 */

import {
  checkCommitMembership,
  type ReleaseMembershipVerdict,
  type ReleaseRef,
} from "./release-membership.js";

export type ReleaseVerificationVerdict = "confirmed" | "failed";

/** One member of the release candidate set. */
export interface ReleaseCandidateMember {
  /** Stable identifier used in reasons, e.g. issue key "OPE-13014" or PR slug. */
  id: string;
  /** Repository slug "owner/repo". */
  repository: string;
  /** Merge commit SHA to test against the deployed release refs. */
  mergeCommitSha: string | null;
  /**
   * True when the member's PR is merged and the merge SHA is recorded. A
   * candidate that is still open/draft/closed-unmerged can never be proven
   * present in the deployed release, so it must fail the check, not be
   * silently dropped from the candidate set.
   */
  merged: boolean;
}

export interface MemberVerification {
  id: string;
  repository: string;
  mergeCommitSha: string | null;
  /** Per-member membership verdict from the release-membership contract. */
  membership: ReleaseMembershipVerdict;
  /** Resolved release refs that were actually consulted for this member. */
  releaseRefs: string[];
}

export type ReleaseFailureReason =
  | "empty_candidate_set"
  | "deployed_version_unknown"
  | "deployed_version_mismatch"
  | "member_sha_missing"
  | "member_not_merged"
  | "member_membership_unknown"
  | "member_missing_from_release";

export interface ReleaseVerificationResult {
  verdict: ReleaseVerificationVerdict;
  /** Human-readable Russian reason, stable enough for a release log. */
  reason: string;
  failureReason: ReleaseFailureReason | null;
  releasePrefix: string;
  /** The deployed version string as supplied (tag / branch / image ref). */
  deployedVersion: string | null;
  members: MemberVerification[];
  /** True only when every member resolved to "present". */
  allMembersPresent: boolean;
  checkedAt: string;
}

/** Options accepted by verifyReleaseComposition. All IO is injectable. */
export interface ReleaseVerificationOptions {
  releasePrefix: string;
  deployedVersion?: string | null;
  members: readonly ReleaseCandidateMember[];
  /** Repository token, forwarded to the membership check. */
  token?: string | null;
  /** GitHub host override (enterprise), forwarded to the membership check. */
  host?: string;
  /**
   * Explicit release refs to consult (resolved tags/branches). When omitted,
   * the membership contract falls back to its own default candidates.
   */
  refs?: readonly ReleaseRef[];
  /**
   * Actual release refs resolved from the repository (tags/branches of the
   * release line). When supplied, the deployedVersion must match one of these
   * refs — otherwise the check fails with `deployed_version_mismatch`.
   */
  resolvedRefs?: readonly ReleaseRef[];
  /** Injectable fetch for deterministic tests. */
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
  /** Clock injection for deterministic checkedAt. */
  now?: () => Date;
}

/**
 * Decide the release-level verdict from per-member memberships.
 *
 * The order of checks encodes the acceptance criteria: an empty candidate set
 * is a failure (never a silent success), a missing deployed version is a
 * failure, and any member that is not provably present fails the release.
 */
export function composeReleaseVerdict(memberships: readonly ReleaseMembershipVerdict[]): {
  verdict: ReleaseVerificationVerdict;
  failureReason: ReleaseFailureReason | null;
  reason: string;
} {
  if (memberships.length === 0) {
    return {
      verdict: "failed",
      failureReason: "empty_candidate_set",
      reason: "Состав выпуска пуст: нет задач для подтверждения.",
    };
  }

  const unknownCount = memberships.filter((m) => m === "unknown").length;
  if (unknownCount > 0) {
    return {
      verdict: "failed",
      failureReason: "deployed_version_unknown",
      reason:
        `Выкаченная версия не установлена или membership неразрешим ` +
        `(${unknownCount} из ${memberships.length} задач в статусе unknown).`,
    };
  }

  const missingCount = memberships.filter((m) => m === "missing_from_release").length;
  if (missingCount > 0) {
    return {
      verdict: "failed",
      failureReason: "member_missing_from_release",
      reason:
        `В выкаченной версии отсутствуют ${missingCount} из ${memberships.length} ` +
        `задач кандидата.`,
    };
  }

  return {
    verdict: "confirmed",
    failureReason: null,
    reason: `Все ${memberships.length} задач кандидата присутствуют в выкаченной версии.`,
  };
}

/**
 * Build the full release candidate set from an issue's pull_request work
 * products. Every pull_request work product is a candidate — merged or not —
 * so the verification sees the complete set and an unmerged candidate fails
 * the release instead of silently shrinking the proven list. Entries that are
 * not pull_request work products are ignored (they carry no merge commit).
 */
export function buildReleaseCandidateMembers(
  workProducts: readonly {
    type: string;
    status: string;
    metadata?: unknown;
  }[],
): ReleaseCandidateMember[] {
  const members: ReleaseCandidateMember[] = [];
  for (const product of workProducts) {
    if (product.type !== "pull_request") continue;
    const metadata = (product.metadata ?? {}) as Record<string, unknown>;
    const repo = typeof metadata.repo === "string" ? metadata.repo : "";
    const number = typeof metadata.number === "number" ? metadata.number : null;
    const mergeCommitSha = typeof metadata.mergeCommitSha === "string" ? metadata.mergeCommitSha : null;
    if (!repo) continue;
    members.push({
      id: number !== null ? `PR#${number}` : "PR#?",
      repository: repo,
      mergeCommitSha,
      merged: product.status === "merged",
    });
  }
  return members;
}

/**
 * Verify the deployed release composition against the candidate set.
 *
 * For each member we call the release-membership contract once. A member with
 * no merge SHA short-circuits to a per-member failure and fails the release —
 * an issue we cannot place on the deployed commit cannot count toward a
 * proven release.
 */
export async function verifyReleaseComposition(
  options: ReleaseVerificationOptions,
): Promise<ReleaseVerificationResult> {
  const now = options.now ?? (() => new Date());
  const checkedAt = now().toISOString();
  const members = options.members;

  // A missing deployed version is a first-class failure: without it we cannot
  // claim the release composition is proven, even if every member SHA happens
  // to resolve against some ref. Fail closed with an explicit reason.
  if (!options.deployedVersion) {
    return {
      verdict: "failed",
      reason:
        "Выкаченная версия не установлена: невозможно подтвердить состав выпуска.",
      failureReason: "deployed_version_unknown",
      releasePrefix: options.releasePrefix,
      deployedVersion: null,
      members: [],
      allMembersPresent: false,
      checkedAt,
    };
  }

  // The deployed version must correspond to a real release ref. The build
  // version is typically `git describe` output ("v1.6.8-15-g4c55f0d") or a
  // resolved tag ("v1.6.8"), so accept either an exact ref match or a describe
  // string anchored at the ref. An arbitrary non-empty string must not let the
  // membership check run against unrelated refs and claim success.
  if (options.resolvedRefs && options.resolvedRefs.length > 0) {
    const deployed = options.deployedVersion;
    const matches = options.resolvedRefs.some(
      (ref) => deployed === ref.ref || deployed.startsWith(`${ref.ref}-`),
    );
    if (!matches) {
      const known = options.resolvedRefs.map((ref) => ref.ref).join(", ");
      return {
        verdict: "failed",
        reason:
          `Выкачанная версия "${options.deployedVersion}" не соответствует ` +
          `ни одному реальному ref релиза (${known}); состав не доказан.`,
        failureReason: "deployed_version_mismatch",
        releasePrefix: options.releasePrefix,
        deployedVersion: options.deployedVersion ?? null,
        members: [],
        allMembersPresent: false,
        checkedAt,
      };
    }
  }

  const emptyGuard = composeReleaseVerdict([]);
  if (members.length === 0) {
    return {
      verdict: emptyGuard.verdict,
      reason: emptyGuard.reason,
      failureReason: emptyGuard.failureReason,
      releasePrefix: options.releasePrefix,
      deployedVersion: options.deployedVersion ?? null,
      members: [],
      allMembersPresent: false,
      checkedAt,
    };
  }

  const verified: MemberVerification[] = [];
  for (const member of members) {
    if (!member.merged || !member.mergeCommitSha) {
      // Not merged (open/draft/closed-unmerged) or merged without a recorded
      // SHA: either way the member cannot be proven present. Keeping it in
      // `verified` with membership "unknown" makes the incomplete candidate
      // set visible instead of silently shrinking the release.
      verified.push({
        id: member.id,
        repository: member.repository,
        mergeCommitSha: member.mergeCommitSha ?? null,
        membership: "unknown",
        releaseRefs: [],
      });
      continue;
    }
    const membership = await checkCommitMembership({
      repository: member.repository,
      sha: member.mergeCommitSha,
      releasePrefix: options.releasePrefix,
      refs: options.refs,
      token: options.token ?? null,
      host: options.host,
      fetchImpl: options.fetchImpl,
    });
    verified.push({
      id: member.id,
      repository: member.repository,
      mergeCommitSha: member.mergeCommitSha,
      membership: membership.verdict,
      releaseRefs: membership.releaseRefs.map((ref) => ref.ref),
    });
  }

  // A candidate whose PR is not merged can never be proven present in the
  // deployed release: the release composition is unproven while any candidate
  // is still open/draft/closed-unmerged. Surface it before the generic
  // unknown-version bucket so the reason names the actual gap. A merged PR
  // without a recorded SHA is a data gap, not an unmerged candidate.
  const notMergedMembers = members.filter((m) => !m.merged);
  if (notMergedMembers.length > 0) {
    const names = notMergedMembers.map((m) => m.id).join(", ");
    return {
      verdict: "failed",
      reason: `Не слиты ${notMergedMembers.length} кандидатов выпуска (${names}); состав не доказан.`,
      failureReason: "member_not_merged",
      releasePrefix: options.releasePrefix,
      deployedVersion: options.deployedVersion ?? null,
      members: verified,
      allMembersPresent: false,
      checkedAt,
    };
  }

  const shaMissing = verified.filter((v) => v.membership === "unknown" && !v.mergeCommitSha);
  if (shaMissing.length > 0) {
    const names = shaMissing.map((v) => v.id).join(", ");
    return {
      verdict: "failed",
      reason: `У ${shaMissing.length} слитых задач нет merge commit SHA (${names}); состав не доказан.`,
      failureReason: "member_sha_missing",
      releasePrefix: options.releasePrefix,
      deployedVersion: options.deployedVersion ?? null,
      members: verified,
      allMembersPresent: false,
      checkedAt,
    };
  }

  const verdict = composeReleaseVerdict(verified.map((v) => v.membership));
  return {
    verdict: verdict.verdict,
    reason: verdict.reason,
    failureReason: verdict.failureReason,
    releasePrefix: options.releasePrefix,
    deployedVersion: options.deployedVersion ?? null,
    members: verified,
    allMembersPresent: verdict.verdict === "confirmed",
    checkedAt,
  };
}
