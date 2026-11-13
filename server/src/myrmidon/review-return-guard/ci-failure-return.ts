// myrmidon(EMPTY-RUNS-3, REVIEW-RETURN-GUARD): when a failed CI check of a pull
// request head takes a task out of review and wakes its executor.
//
// The GitHub connection events returned a task `in_review -> in_progress` on
// the first failed job of the head (one `check_run` delivery), before the CI
// of the head had a verdict and without a look at the base branch. On 13.11,
// the first day the App delivered check events, that was 48 returns; after main
// went red at 06:29Z (`tests (serialized 1/2)`, `tests (server 3/6)`,
// `tests (server 6/6)`), 13 more, 6 of them on the very shards that were red on
// main. The executor had nothing to change: one such run made 139 model calls
// on 5.88M input tokens to answer "main is red".
//
// Three facts of the head, read from GitHub at the moment of the delivery, are
// enough to tell a return that has something to do from one that has not:
//
//   - the CI of the head has a verdict: its final `CI result` check finished
//     (a repository without that aggregate check: every check finished). A
//     failed lane with the rest still running is not a verdict yet;
//   - which checks failed: nothing but infrastructure checks (`CI result`
//     failing alone on its own gate) is not a failure of the code — the same
//     rule the reviewer's return already follows (./policy.ts);
//   - whether `main-green` failed on the head. That check of the "Main green
//     gate" workflow is red exactly while the base branch is red (an open
//     `main-red` issue or a failed last completed CI run of main), and the
//     workflow re-runs it on every open pull request once main is green again.
//     While it is red the lanes of the head ran on a broken base: the task
//     stays in review, the executor is not woken, and the `ci_infra_retry_needed`
//     row is written. The re-run turns the check green and its delivery brings
//     the head here again; a head that is still red then goes back to its
//     executor, who can now re-run the jobs or fix what is really its own.
//
// Lane names are deliberately not compared with the lanes that failed on main:
// a pull request without the `full-ci` label runs `tests (affected)`, main runs
// the shards, so the same broken test fails under different names.
//
// The same notion of "the CI of the head is finished" decides what a delivery
// does to the task at all. The events treated every finished job — and every
// finished run of an auxiliary workflow — as a finished CI: the task's monitor
// was disarmed and its assignee woken by the first job that ended, so an agent
// that had armed a monitor for the result was brought back minutes later to
// find "4 jobs still running". Only the delivery that carries the final result
// of the current head is a finished CI (`classifyCiDelivery`,
// `isCiVerdictConclusion`); the rest leave the task alone.
//
// No database and no network here. A head the board cannot read is not decided
// by this file at all.

import { REVIEW_CI_FINAL_CHECK_NAME } from "../review-stage-recovery/policy.js";

/**
 * The check that is red on a pull request head while the base branch is red
 * (job `main-green` of the "Main green gate" workflow). It counts only while it
 * is on the infrastructure list (`MYRMIDON_REVIEW_INFRA_CHECK_NAMES`): a
 * repository that removed it from the list has no base-branch hold.
 */
export const BASE_BRANCH_RED_CHECK_NAME = "main-green";

/**
 * Kill switch of the handling of CI deliveries by the final result of the head.
 * Unset or any value but an explicit off keeps it on; off brings back the old
 * handling (every completed delivery is a finished CI).
 */
export const CI_FINAL_ONLY_ENABLED_ENV = "MYRMIDON_GITHUB_CI_FINAL_ONLY_ENABLED";

export function readCiFinalOnlyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[CI_FINAL_ONLY_ENABLED_ENV]?.trim().toLowerCase();
  return !(raw === "0" || raw === "false" || raw === "off" || raw === "no");
}

/** Key of the hold mark in the metadata of the pull request work product. */
export const CI_RETURN_HOLD_METADATA_KEY = "ciReturnHold";

/**
 * Key of the mark "this pull request has the final check" in the metadata of
 * its work product. Once a delivery of the final check was seen, only that
 * check ends the CI of a head; before it — and in a repository without the
 * aggregate check — a finished workflow run is looked up on GitHub instead.
 */
export const CI_FINAL_CHECK_SEEN_METADATA_KEY = "ciFinalCheckSeen";

/** Reasons of a hold, as written to the mark and to the `ci_infra_retry_needed` row. */
export type CiReturnHoldReason = "ci_infra_only" | "base_branch_red";

/** Conclusions of a finished check or run that mean it failed (cancelled and skipped ones are not failures). */
const FAILED_CI_CONCLUSIONS: ReadonlySet<string> = new Set(["failure", "timed_out", "action_required", "startup_failure"]);

export function isFailedCiConclusion(conclusion: string | null | undefined): boolean {
  return typeof conclusion === "string" && FAILED_CI_CONCLUSIONS.has(conclusion);
}

/**
 * Conclusions of a finished final check that are not a result of the head: the
 * run was superseded by a newer one (cancelled, stale) or did not apply
 * (skipped). The same list the CI state of a head is read with
 * (review-stage-recovery/policy.ts).
 */
const NOT_A_VERDICT_CONCLUSIONS: ReadonlySet<string> = new Set(["cancelled", "skipped", "stale"]);

/** A finished final check with this conclusion is the result of the head. */
export function isCiVerdictConclusion(conclusion: string | null | undefined): boolean {
  return typeof conclusion === "string" && conclusion.trim() !== "" && !NOT_A_VERDICT_CONCLUSIONS.has(conclusion);
}

/**
 * What one CI delivery of a pull request head is:
 *   - `final_check` — the aggregate check itself (`CI result`): its finished
 *     run is the result of the head;
 *   - `lane` — any other check. One job never finishes the CI, and a check
 *     delivered without a name is taken for one: the run it belongs to is
 *     delivered as a whole as well;
 *   - `whole_run` — a workflow run or a check suite. It finishes the CI only in
 *     a repository without the aggregate check, which GitHub has to confirm.
 */
export type CiDeliveryKind = "final_check" | "lane" | "whole_run";

export function classifyCiDelivery(input: {
  /** `check_run`, `check_suite` or `workflow_run`. */
  eventName: string;
  checkName: string | null | undefined;
  finalCheckName?: string;
}): CiDeliveryKind {
  if (input.eventName !== "check_run") return "whole_run";
  const name = typeof input.checkName === "string" ? input.checkName.trim() : "";
  return name !== "" && name === (input.finalCheckName ?? REVIEW_CI_FINAL_CHECK_NAME) ? "final_check" : "lane";
}

/** The check runs of one head commit, as GitHub reports them at the moment of the decision. */
export interface CiReturnHeadFacts {
  /** Names of the checks whose latest run finished with a failing conclusion. */
  failed: readonly string[];
  /** The head has at least one check run and every one of them has finished. */
  finished: boolean;
  /** The head has a run of the final check, whatever its state. */
  hasFinalCheck: boolean;
  /** Conclusion of the finished final check; null while it is missing, running, cancelled or skipped. */
  finalCheckConclusion: string | null;
}

export type CiReturnFacts =
  | ({ state: "ok" } & CiReturnHeadFacts)
  /** The board could not read the check runs; the caller keeps its old behaviour. */
  | { state: "unknown"; reason: string };

/** Reads the check runs of the head of one pull request, now and without a cache. */
export type CiReturnFactsResolver = (input: {
  companyId: string;
  /** `owner/repo`. */
  repository: string;
  pullRequestNumber: number;
  headSha: string;
}) => Promise<CiReturnFacts>;

export type CiFailureReturnDecision =
  /** The CI of the head has no verdict yet: nothing is done, a later delivery decides. */
  | { action: "wait" }
  /** The CI of the head is final and gives no reason for a return. */
  | { action: "none" }
  /** The task goes back to its executor. */
  | { action: "return"; failedChecks: string[] }
  /** The task stays in review and the executor is not woken. */
  | { action: "hold"; reason: CiReturnHoldReason; failedChecks: string[] };

function normalizeCheckName(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * The CI of the head has a verdict. With the aggregate check on the head only
 * its finished run counts (a cancelled or skipped one is a superseded run, not
 * a verdict); without it, the moment every check has finished.
 */
export function isHeadCiFinal(head: CiReturnHeadFacts): boolean {
  return head.hasFinalCheck ? head.finalCheckConclusion !== null : head.finished;
}

/**
 * The result of a head whose CI is final: the conclusion of the aggregate
 * check, or — without it — failure when any check failed. Null while the CI of
 * the head is not final.
 */
export function ciVerdictOfHead(head: CiReturnHeadFacts): string | null {
  if (!isHeadCiFinal(head)) return null;
  if (head.hasFinalCheck) return head.finalCheckConclusion;
  return head.failed.length > 0 ? "failure" : "success";
}

export function decideCiFailureReturn(input: {
  head: CiReturnHeadFacts;
  /** Check names whose failure does not say anything about the code (`readReviewInfraCheckNames`). */
  infraCheckNames: readonly string[];
  finalCheckName?: string;
  baseRedCheckName?: string;
}): CiFailureReturnDecision {
  if (!isHeadCiFinal(input.head)) return { action: "wait" };

  const failed: string[] = [];
  for (const name of input.head.failed) {
    if (typeof name === "string" && name.trim() !== "" && !failed.includes(name)) failed.push(name);
  }
  if (failed.length === 0) return { action: "none" };

  const infra = new Set(input.infraCheckNames.map(normalizeCheckName));
  const finalCheckName = normalizeCheckName(input.finalCheckName ?? REVIEW_CI_FINAL_CHECK_NAME);
  const baseRedCheckName = normalizeCheckName(input.baseRedCheckName ?? BASE_BRANCH_RED_CHECK_NAME);
  const failedNames = failed.map(normalizeCheckName);

  const codeFailed = failedNames.filter((name) => !infra.has(name));
  if (codeFailed.length === 0) {
    // Only infrastructure checks failed. A red aggregate with every lane green
    // failed on its own gate and needs a re-run; a red `main-green` beside a
    // green aggregate is the merge gate of a red base, not a CI failure.
    return failedNames.includes(finalCheckName)
      ? { action: "hold", reason: "ci_infra_only", failedChecks: failed }
      : { action: "none" };
  }
  if (infra.has(baseRedCheckName) && failedNames.includes(baseRedCheckName)) {
    return { action: "hold", reason: "base_branch_red", failedChecks: failed };
  }
  return { action: "return", failedChecks: failed };
}

/** The hold mark kept on the pull request work product: one hold per head. */
export interface CiReturnHoldMark {
  headSha: string;
  reason: CiReturnHoldReason;
  failedChecks: string[];
  heldAt: string;
}

/** Reads the hold mark from work-product metadata; anything malformed is no mark. */
export function readCiReturnHoldMark(metadata: unknown): CiReturnHoldMark | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const raw = (metadata as Record<string, unknown>)[CI_RETURN_HOLD_METADATA_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const mark = raw as Record<string, unknown>;
  const headSha = mark.headSha;
  if (typeof headSha !== "string" || headSha.trim() === "") return null;
  const rawReason = mark.reason;
  const reason: CiReturnHoldReason | null =
    rawReason === "ci_infra_only" || rawReason === "base_branch_red" ? rawReason : null;
  if (!reason) return null;
  const rawFailedChecks: unknown = mark.failedChecks;
  const heldAt = mark.heldAt;
  return {
    headSha,
    reason,
    failedChecks: Array.isArray(rawFailedChecks)
      ? rawFailedChecks.filter((name): name is string => typeof name === "string")
      : [],
    heldAt: typeof heldAt === "string" ? heldAt : "",
  };
}

function shortSha(headSha: string): string {
  return headSha.slice(0, 8);
}

/** The system note left in the task thread when a failed CI does not return the task; it wakes nobody. */
export function buildCiReturnHoldNote(input: {
  reason: CiReturnHoldReason;
  headSha: string;
  failedChecks: readonly string[];
}): string {
  const failed = input.failedChecks.join(", ");
  if (input.reason === "base_branch_red") {
    return (
      `CI головы ${shortSha(input.headSha)} завершился с ошибкой (упали: ${failed}), но проверка ` +
      `${BASE_BRANCH_RED_CHECK_NAME} показывает красную базовую ветку — задача остаётся на ревью, исполнитель не будится. ` +
      `Когда базовая ветка позеленеет и ${BASE_BRANCH_RED_CHECK_NAME} пройдёт на этой голове, доска вернёт задачу исполнителю, ` +
      "если CI головы всё ещё красный (ci_infra_retry_needed)."
    );
  }
  return (
    `CI головы ${shortSha(input.headSha)} упал только на инфраструктурных проверках (упали: ${failed}) — ` +
    "задача остаётся на ревью, исполнитель не будится. Нужен перезапуск упавших джобов (ci_infra_retry_needed)."
  );
}

/** What is appended to the return comment, so the executor does not have to rediscover it. */
export function buildCiReturnNote(input: { failedChecks: readonly string[]; releasedHold: CiReturnHoldReason | null }): string {
  const failed = input.failedChecks.length > 0 ? ` Failed checks: ${input.failedChecks.join(", ")}.` : "";
  if (input.releasedHold === "base_branch_red") {
    return (
      `${failed} These ran while the base branch was red; ${BASE_BRANCH_RED_CHECK_NAME} passes on this head now: ` +
      "re-run the failed jobs or update the branch first, and change code only for what fails again."
    );
  }
  return failed;
}
