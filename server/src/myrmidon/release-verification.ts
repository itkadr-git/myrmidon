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
  | "member_sha_missing"
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
    if (!member.mergeCommitSha) {
      verified.push({
        id: member.id,
        repository: member.repository,
        mergeCommitSha: null,
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

  // A member without a SHA cannot be proven present; surface it before the
  // generic unknown-version bucket so the reason names the actual gap.
  const shaMissing = verified.filter((v) => v.membership === "unknown" && !v.mergeCommitSha);
  if (shaMissing.length > 0) {
    const names = shaMissing.map((v) => v.id).join(", ");
    return {
      verdict: "failed",
      reason: `У ${shaMissing.length} задач нет merge commit SHA (${names}); состав не доказан.`,
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
