#!/usr/bin/env node
// RELEASE-JOBS (OPE-13002): the single source of truth for which jobs belong
// to a release-tag build and how the release build is prioritised in the CI
// queue.
//
// The myrmidon-ci-tag.yml workflow runs the full tier on every release tag.
// Its "CI result" job must wait for every lane of THAT build — and only those
// lanes. Today the latency check hardcodes the job names; when a lane is
// added, renamed or dropped the check silently watches the wrong set. This
// module derives the job set from the workflow file itself, so the gate
// always tracks the real build.
//
// The module exports pure helpers (no side effects) so tests can import it:
//   - extractJobGraph(workflowYaml)      -> ordered {id, name, needs} entries
//   - extractJobs(workflowYaml)          -> ordered job names from a workflow
//   - buildJobs(allJobs)                 -> the build set (gate job excluded)
//   - gateDependencyJobs(yaml, gateId)   -> the gate's transitive needs
//                                           closure (display names) — the
//                                           ONLY jobs the gate may wait for.
//                                           THROWS when a declared needs id
//                                           cannot be resolved to a workflow
//                                           job (typo or unsupported YAML
//                                           form) — a partial set must never
//                                           pass silently (fail closed)
//   - matchesJob(observed, expected)     -> exact or template job-name match
//   - isReleaseBuildJob(jobName, jobs)   -> does this job belong to the build?
//   - computeQueueOrder(jobs)            -> queue positions with release priority
//   - isReleaseRun(run)                  -> is a CI run a release-tag build?
//   - isReleaseWorkflowRun(run)          -> is a run of the release CI workflow?
//   - priorityViolations(runs, actualPos)-> release runs behind a later-queued
//                                           ordinary run, by ACTUAL position
//   - observedPriorityViolations(runs)   -> proven inversions from factual
//                                           dispatch order (started_at), no
//                                           assumed queue positions
//   - gateState(buildJobs, observedJobs) -> {complete, missing, foreign}
//
// A foreign job (one not in the build set) never satisfies the gate and never
// blocks it — the gate waits only for the build's own jobs.
//
// Tests: scripts/myrmidon/release/release-jobs.test.mjs

/**
 * Parse a GitHub Actions workflow YAML (minimal parser — enough for the
 * job-graph extraction we need; the workflow files are machine-generated and
 * follow a strict format).
 *
 * @param {string} yamlText
 * @returns {Array<{id: string, name: string, needs: string[]}>} jobs in file
 *   order; `name` is the display name (falls back to the id), `needs` is the
 *   literal job-id list from the job's `needs:` key (empty when absent).
 * @throws {Error} when a `needs:` entry is malformed (not a job-id token) —
 *   parsing must never silently drop a declared dependency.
 */
export function extractJobGraph(yamlText) {
  const lines = yamlText.split("\n");
  const jobs = [];
  let inJobs = false;
  let collectingNeedsFor = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!inJobs) {
      if (/^jobs:\s*$/.test(line)) inJobs = true;
      continue;
    }
    const indent = line.match(/^ */)[0].length;
    if (indent === 0 && line.trim() !== "" && !line.startsWith("#") && !/^jobs:/.test(line)) {
      break;
    }
    if (indent === 2) {
      const jobMatch = /^  ([a-zA-Z_][a-zA-Z0-9_-]*):\s*$/.exec(line);
      if (jobMatch) {
        jobs.push({ id: jobMatch[1], name: jobMatch[1], needs: [] });
        collectingNeedsFor = null;
      }
      continue;
    }
    const current = jobs[jobs.length - 1];
    if (!current) continue;
    if (indent === 4) {
      collectingNeedsFor = null;
      const nameMatch = /^    name:\s*(.+)$/.exec(line);
      if (nameMatch) {
        current.name = nameMatch[1].trim().replace(/^["']|["']$/g, "");
        continue;
      }
      const needsMatch = /^    needs:\s*(.*)$/.exec(line);
      if (needsMatch) {
        const raw = needsMatch[1].trim();
        if (raw === "") {
          // YAML list form on following lines:
          //   needs:
          //     - a
          //     - b
          collectingNeedsFor = current;
        } else {
          const listMatch = /^\[(.*)\]$/.exec(raw);
          if (listMatch) {
            for (const item of listMatch[1].split(",")) {
              const id = item.trim().replace(/^["']|["']$/g, "");
              if (!/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(id)) {
                throw new Error(
                  `unparseable needs entry in job "${current.id}": ${JSON.stringify(item.trim())}`
                );
              }
              current.needs.push(id);
            }
          } else {
            // Single id form: needs: build
            const id = raw.replace(/^["']|["']$/g, "");
            if (!/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(id)) {
              throw new Error(
                `unparseable needs entry in job "${current.id}": ${JSON.stringify(raw)}`
              );
            }
            current.needs.push(id);
          }
        }
        continue;
      }
      continue;
    }
    if (indent === 6 && collectingNeedsFor) {
      const itemMatch = /^      -\s+(.+)$/.exec(line);
      if (itemMatch) {
        const id = itemMatch[1].trim().replace(/^["']|["']$/g, "");
        if (!/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(id)) {
          throw new Error(
            `unparseable needs entry in job "${collectingNeedsFor.id}": ${JSON.stringify(itemMatch[1].trim())}`
          );
        }
        collectingNeedsFor.needs.push(id);
      }
    }
  }
  return jobs;
}

/**
 * Job display names in file order (backward-compatible view of the graph).
 *
 * @param {string} yamlText
 * @returns {string[]} job names in file order
 */
export function extractJobs(yamlText) {
  return extractJobGraph(yamlText).map((j) => j.name);
}

/**
 * Which jobs belong to the release-tag build. The "CI result" job is the
 * gate itself — it is not part of the build set it watches.
 *
 * @param {string[]} allJobs
 * @returns {string[]} build jobs (excluding the gate job)
 */
export function buildJobs(allJobs) {
  return allJobs.filter((j) => j !== "CI result");
}

/**
 * The exact set of jobs the gate job waits for: the transitive closure of
 * its `needs:` graph. A workflow job that is NOT in this closure (an extra
 * lane, a side job, a differently-keyed helper) must never become mandatory
 * for the gate — the reviewer blocker on OPE-13002.
 *
 * @param {string} yamlText
 * @param {string} gateJobId  the gate job's workflow id (e.g. "ci-result")
 * @returns {string[]} display names of the gate's dependency closure in file
 *   order; empty when the gate job is absent (callers must fail closed on
 *   empty).
 * @throws {Error} when a `needs:` entry of the gate or any of its transitive
 *   dependencies references a job id that does not exist in this workflow.
 *   A typo or a job defined below via an unsupported YAML construct must
 *   fail closed with an explicit error, never yield a partial non-empty set
 *   that silently omits a required job (reviewer finding on OPE-13002).
 */
export function gateDependencyJobs(yamlText, gateJobId) {
  const graph = extractJobGraph(yamlText);
  const byId = new Map(graph.map((j) => [j.id, j]));
  const gate = byId.get(gateJobId);
  if (!gate) return [];
  const seen = new Set();
  const stack = [...gate.needs];
  while (stack.length > 0) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    const job = byId.get(id);
    if (!job) {
      throw new Error(
        `gate "${gateJobId}" declares dependency "${id}" which is not a job of this workflow — refusing an incomplete build set (fail closed)`
      );
    }
    seen.add(id);
    stack.push(...job.needs);
  }
  return graph.filter((j) => seen.has(j.id)).map((j) => j.name);
}

/**
 * Does a job name belong to the release build?
 *
 * @param {string} jobName
 * @param {string[]} buildJobSet
 * @returns {boolean}
 */
export function isReleaseBuildJob(jobName, buildJobSet) {
  return buildJobSet.some((expected) => matchesJob(jobName, expected));
}

/**
 * Does an observed job name match an expected job name from the workflow?
 *
 * Exact match, or template match: an expected name containing a GitHub
 * Actions expression `${{ ... }}` (e.g. the matrix-expanded
 * `tests (${{ matrix.label }})`) matches any observed name that equals the
 * template with the expression replaced by arbitrary text. The static parts
 * of the template must match exactly and in order, so `tests (server 1/6)`
 * matches `tests (${{ matrix.label }})` but `tests-other (x)` or
 * `someone-elses-job` do not.
 *
 * @param {string} observedName  job name as reported by the GitHub API
 * @param {string} expectedName  job name (possibly a template) from the workflow
 * @returns {boolean}
 */
export function matchesJob(observedName, expectedName) {
  if (observedName === expectedName) return true;
  if (!expectedName.includes("${{")) return false;
  const parts = expectedName.split(/\$\{\{[^}]*\}\}/).map(escapeRegExp);
  const pattern = new RegExp(`^${parts.join(".*")}$`);
  return pattern.test(observedName);
}

/** @param {string} s */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Compute the queue position of a release build relative to other pending
 * builds. Release builds get priority: they jump ahead of non-release builds
 * that are still queued.
 *
 * @param {Array<{name: string, isRelease: boolean, queuedAt: string}>} pendingBuilds
 * @returns {Array<{name: string, position: number, isRelease: boolean}>}
 *   Builds sorted by queue position (0 = runs next). Release builds are
 *   placed before non-release builds; within the same priority class the
 *   original queue order (queuedAt) is preserved (stable).
 */
export function computeQueueOrder(pendingBuilds) {
  const withIdx = pendingBuilds.map((b, i) => ({ ...b, originalIndex: i }));
  const release = withIdx.filter((b) => b.isRelease);
  const ordinary = withIdx.filter((b) => !b.isRelease);
  // Stable sort by queuedAt within each class
  const byTime = (a, b) => a.queuedAt.localeCompare(b.queuedAt) || a.originalIndex - b.originalIndex;
  release.sort(byTime);
  ordinary.sort(byTime);
  const ordered = [...release, ...ordinary];
  return ordered.map((b, position) => ({
    name: b.name,
    position,
    isRelease: b.isRelease,
  }));
}

/**
 * Classify a CI run (from the GitHub Actions API) as a release build or an
 * ordinary build. A release build is any run of a release tag
 * (`refs/tags/myr-v*.*.*`, including `-rc.N`) — the release-tag CI, the
 * image build for the tag, the release publish. Everything else (branch
 * pushes, PRs, merge groups) is an ordinary build.
 *
 * The priority runner pool (myrmidon-ci.yml `is_release`) covers a slightly
 * broader set — main pushes and release PRs also receive the priority label.
 * A main push is therefore a priority-pool run even though it is not a
 * release build; the queue monitor treats only tag-ref runs as release
 * builds and everything else (including main pushes) as ordinary.
 *
 * @param {{head_branch?: string, head_sha?: string, event?: string, path?: string, name?: string}} run
 * @returns {boolean}
 */
export function isReleaseRun(run) {
  const branch = run.head_branch || "";
  return /^myr-v\d+\.\d+\.\d+(-rc\.\d+)?$/.test(branch);
}

/**
 * Does this run occupy the priority runner pool (vars.CI_RUNNER_PRIORITY)?
 * The routing decision lives in myrmidon-ci.yml plan job (is_release): a run
 * is sent to the priority pool when its ref is main, a tag, or a release
 * stream PR (title containing "rc.N"/"release", or head/base ref under
 * rel/). The queue monitor MUST use the same predicate: classifying a
 * priority-pool run as "ordinary" produces false inversions (a main push or
 * release PR that legitimately started on the priority pool would be
 * reported as blocking a queued tag build), and classifying an ordinary run
 * as priority hides real inversions. GitHub's workflow_runs list exposes
 * head_branch, event and display_title (the PR title for pull_request
 * runs), which is enough to reproduce the plan predicate exactly.
 *
 * @param {{head_branch?: string, event?: string, display_title?: string}} run
 * @returns {boolean}
 */
export function isPriorityPoolRun(run) {
  const branch = run.head_branch || "";
  if (/^myr-v\d+\.\d+\.\d+(-rc\.\d+)?$/.test(branch)) return true;
  if (branch === "main") return true;
  if (branch.startsWith("rel/")) return true;
  const title = run.display_title || "";
  if (/(rc\.[0-9]+|release)/.test(title)) return true;
  return false;
}

/**
 * Evaluate the queue priority: a release build must never wait behind an
 * ordinary build that queued AFTER it.
 *
 * @deprecated Use priorityViolations(pendingRuns, actualPosition), which
 * takes the ACTUAL queue position instead of assuming the input array order
 * is the queue order (the GitHub API documents no such ordering for its
 * workflow_runs list). Kept as a thin wrapper over priorityViolations for
 * existing callers that pass a genuinely position-ordered list.
 *
 * @param {Array<{id?: number|string, name: string, isRelease: boolean, queuedAt: string}>} pendingRuns
 *   Pending CI runs in actual queue order, each with its queue timestamp.
 * @returns {Array<{release: string, releaseQueuedAt: string, blockedBy: string, blockedByQueuedAt: string}>}
 *   One entry per (release build, ordinary build queued later) pair where
 *   the ordinary build nevertheless holds a better queue position. An
 *   empty array means the queue gives release builds priority.
 */
export function queueViolations(pendingRuns) {
  const positionByKey = new Map(
    pendingRuns.map((r, i) => [String(r.id ?? r.name), i])
  );
  return priorityViolations(pendingRuns, positionByKey);
}

/**
 * Is this a run of the release-tag CI workflow ("Myrmidon CI (tag)")? These
 * runs are the release builds whose latency matters: the publish gate accepts
 * ONLY their green "CI result". Every other workflow (branch CI, image
 * builds, publish) is auxiliary — its queue position does not gate a release.
 *
 * @param {{name?: string, path?: string}} run
 * @returns {boolean}
 */
export function isReleaseWorkflowRun(run) {
  return run.name === "Myrmidon CI (tag)";
}

/**
 * Evaluate queue priority against ACTUAL queue positions.
 *
 * The enforcement mechanism is the priority runner pool: the main CI
 * workflow sends every release run (`is_release` from the plan job) to
 * `vars.CI_RUNNER_PRIORITY` — a dedicated runner label that ordinary runs
 * never receive. Release runs therefore start before any queued ordinary
 * run whenever a priority runner is free, and an idle priority runner picks
 * the OLDEST queued release run first (FIFO within the release class). The
 * only starvation risk is a burst of simultaneous release tags exceeding
 * the priority pool while ordinary runs hold the shared pool.
 *
 * This function evaluates exactly that residual risk. `actualPosition` must
 * be the run's real position in the pending queue, oldest first — e.g. the
 * position after sorting the API's `workflow_runs` array by `created_at`
 * ascending (the API's own list order is NOT a queue-position contract).
 *
 * @param {Array<{id?: number|string, name: string, isRelease: boolean, queuedAt: string}>} pendingRuns
 *   Pending runs of the release CI workflow, each with its queue timestamp.
 * @param {Map<string, number>|((run: {id?: number|string, name: string}) => number)} actualPosition
 *   Actual queue position (0 = runs next) by run id or name, oldest first.
 * @returns {Array<{release: string, releaseQueuedAt: string, blockedBy: string, blockedByQueuedAt: string}>}
 *   One entry per (release run, ordinary run queued later) pair where the
 *   ordinary run nevertheless holds a better actual queue position. An
 *   empty array means the queue gives release builds priority.
 */
export function priorityViolations(pendingRuns, actualPosition) {
  const pos =
    actualPosition instanceof Map
      ? (r) => actualPosition.get(String(r.id ?? r.name)) ?? Number.POSITIVE_INFINITY
      : actualPosition;
  const violations = [];
  for (const release of pendingRuns.filter((r) => r.isRelease)) {
    for (const ordinary of pendingRuns.filter(
      (r) => !r.isRelease && r.queuedAt >= release.queuedAt
    )) {
      if (pos(ordinary) < pos(release)) {
        violations.push({
          release: release.name,
          releaseQueuedAt: release.queuedAt,
          blockedBy: ordinary.name,
          blockedByQueuedAt: ordinary.queuedAt,
        });
      }
    }
  }
  return violations;
}

/**
 * Observe queue priority from FACTUAL dispatch order — no assumed positions.
 *
 * The reviewer's blocker on OPE-13002: comparing runs by `created_at` order
 * assumes queue position; a runner label alone does not prove the queue
 * honoured it. This check uses only facts the GitHub API records:
 *
 *   - A run's `started_at` is written by the dispatcher the moment a runner
 *     picks the run up. An ordinary run that queued LATER than a release run
 *     but already carries `started_at` while the release run does not has
 *     FACTUALLY been dispatched ahead of it — a proven priority inversion.
 *   - Among runs that have not started yet, no external observation can
 *     rank them; their order is enforced by the priority runner pool
 *     (myrmidon-ci.yml `is_release` -> vars.CI_RUNNER_PRIORITY). That
 *     mechanism's wiring is asserted by the ci-routing wiring tests, and
 *     the moment any later-queued ordinary run starts ahead of a release
 *     run this function flags it.
 *
 * @param {Array<{id?: number|string, name?: string, head_branch?: string, status?: string, created_at?: string, started_at?: string|null}>} runs
 *   Pending runs of the competing release CI workflows (queued or in_progress).
 * @returns {Array<{release: string, releaseQueuedAt: string, blockedBy: string, blockedByQueuedAt: string, blockedByStartedAt: string}>}
 *   One entry per proven inversion: a release run still without `started_at`
 *   while an ordinary run that queued after it has already started. An empty
 *   array means no factual priority inversion is observable.
 */
export function observedPriorityViolations(runs) {
  const violations = [];
  const normalized = runs.map((r) => ({
    id: String(r.id ?? r.head_branch ?? r.name ?? ""),
    name: r.head_branch || r.name || String(r.id ?? ""),
    // The queue invariant is about the PRIORITY POOL, not just tag builds:
    // every run routed to vars.CI_RUNNER_PRIORITY (tag builds, main pushes,
    // release PRs) is allowed to start ahead of later-queued ordinary runs;
    // only runs that never receive the priority label can commit an
    // inversion. Classification mirrors the myrmidon-ci.yml plan predicate
    // (isPriorityPoolRun) so no priority-pool run is misreported as ordinary.
    isRelease: isPriorityPoolRun(r),
    queuedAt: r.created_at || "",
    startedAt: r.started_at || null,
    status: r.status || "",
  }));
  for (const release of normalized.filter(
    (r) => r.isRelease && !r.startedAt && (r.status === "queued" || r.status === "in_progress" || r.status === "")
  )) {
    for (const ordinary of normalized.filter(
      (r) => !r.isRelease && r.startedAt && r.queuedAt >= release.queuedAt
    )) {
      violations.push({
        release: release.name,
        releaseQueuedAt: release.queuedAt,
        blockedBy: ordinary.name,
        blockedByQueuedAt: ordinary.queuedAt,
        blockedByStartedAt: ordinary.startedAt,
      });
    }
  }
  return violations;
}

/**
 * Evaluate the gate: which build jobs are complete, which are still missing,
 * and are there any foreign jobs that should not be counted?
 *
 * @param {string[]} expectedJobs  the build's own job names
 * @param {Array<{name: string, conclusion: string}>} observedJobs
 *   jobs observed in the CI run (from the GitHub API)
 * @returns {{
 *   complete: boolean,       // every expected job completed successfully
 *   missing: string[],       // expected jobs with no successful conclusion
 *   foreign: string[],       // observed jobs not in the expected set
 *   failed: string[],        // expected jobs that completed but not successfully
 * }}
 */
export function gateState(expectedJobs, observedJobs) {
  const missing = [];
  const failed = [];
  const foreign = [];

  for (const job of observedJobs) {
    if (!expectedJobs.some((name) => matchesJob(job.name, name))) {
      foreign.push(job.name);
    }
  }

  for (const name of expectedJobs) {
    const match = observedJobs.find((j) => matchesJob(j.name, name));
    if (!match) {
      missing.push(name);
    } else if (match.conclusion !== "success") {
      failed.push(name);
    }
  }

  return {
    complete: missing.length === 0 && failed.length === 0,
    missing,
    foreign,
    failed,
  };
}
