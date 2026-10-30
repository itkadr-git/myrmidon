// scripts/myrmidon/ci/ci-routing.mjs
// Logic for PR release classification, concurrency group resolution,
// cancel-in-progress determination, and superseded head detection.

/**
 * Determines whether a pull request belongs to a release stream
 * based on title (rc.* or release), release label, or rel/* head/base branch.
 */
export function isReleasePR({ title = '', labels = [], headRef = '', baseRef = '' } = {}) {
  const labelNames = Array.isArray(labels)
    ? labels.map((l) => (typeof l === 'string' ? l : l?.name)).filter(Boolean)
    : [];
  if (labelNames.includes('release')) return true;
  if (headRef.startsWith('rel/') || baseRef.startsWith('rel/')) return true;
  if (/rc\.[0-9]+/i.test(title) || /\brelease\b/i.test(title)) return true;
  return false;
}

/**
 * Computes the GitHub Actions concurrency group name.
 * Release PRs receive an isolated 'release-' prefix so ordinary PRs
 * cannot block or cancel release testing.
 */
export function computeConcurrencyGroup({
  eventName,
  action,
  labelName,
  prNumber,
  prTitle = '',
  prLabels = [],
  headRef = '',
  baseRef = '',
  ref = '',
}) {
  const isRel = isReleasePR({ title: prTitle, labels: prLabels, headRef, baseRef });
  const prefix = isRel ? 'release-' : '';
  const target = prNumber ? String(prNumber) : ref;
  const isLabelNoop =
    eventName === 'pull_request' &&
    action === 'labeled' &&
    labelName !== 'full-ci' &&
    labelName !== 'review-approved';
  return `myrmidon-ci-${prefix}${target}${isLabelNoop ? '-label-noop' : ''}`;
}

/**
 * Evaluates whether an in-progress run should be cancelled when a new event arrives.
 * - Pushes to main: false (main runs are protected and run to completion).
 * - Merge group: false (merge queue checks run to completion).
 * - PR fresh push (run_attempt === 1): true (cancels obsolete run of old commit).
 * - PR rerun (run_attempt > 1): false (manual or scheduled reruns do NOT cancel the active head run).
 */
export function computeCancelInProgress({
  eventName,
  action,
  labelName,
  runAttempt = 1,
  ref = '',
}) {
  if (eventName === 'push' && ref === 'refs/heads/main') {
    return false;
  }
  if (eventName === 'merge_group') {
    return false;
  }
  if (eventName === 'pull_request') {
    if (runAttempt > 1) {
      return false;
    }
    if (action === 'labeled' && labelName !== 'full-ci' && labelName !== 'review-approved') {
      return false;
    }
    return true;
  }
  return false;
}

/**
 * Checks whether the current commit being checked is already superseded
 * by a newer head commit in the same pull request.
 */
export function isSupersededHead({ eventName, currentHead, prHead }) {
  if (eventName !== 'pull_request') return false;
  if (!currentHead || !prHead) return false;
  return currentHead !== prHead;
}
