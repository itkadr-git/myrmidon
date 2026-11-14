#!/usr/bin/env bash
# scripts/myrmidon/ci/hot-files-check.sh
#
# HOT FILES REVIEW CHECK
# Checks whether any protected/core files are touched by a PR.
# If touched, requires 'review-approved' label before passing hot-files-review status.
# If not touched (or on merge_group), passes immediately.

set -euo pipefail

EVENT="${EVENT:-${GITHUB_EVENT_NAME:-}}"
REPO="${REPO:-${GITHUB_REPOSITORY:-itkadr-git/myrmidon}}"
PR="${PR:-${PULL_REQUEST_NUMBER:-}}"
SHA="${SHA:-${GITHUB_SHA:-}}"
ACTION="${ACTION:-}"
LABELS="${LABELS:-}"

# A rerun can still carry a synchronize event from its original push. Compare
# issue label timestamps with the head commit instead of trusting run_attempt.
if [[ "$ACTION" == "synchronize" && -n "$SHA" ]]; then
  head_date="$(gh api "repos/$REPO/commits/$SHA" --jq '.commit.committer.date' 2>/dev/null || true)"
  label_date="$(gh api "repos/$REPO/issues/$PR/events" --paginate --jq '[.[] | select(.event == "labeled" and .label.name == "review-approved") | .created_at] | max // empty' 2>/dev/null || true)"
  if [[ -n "$head_date" && -n "$label_date" && "$label_date" > "$head_date" ]]; then
    echo "Метка review-approved поставлена после коммита головы — сохраняем её."
    ACTION=""
  else
    head="$(gh api "repos/$REPO/commits/$SHA" --jq '[(.parents|length),.author.login,.committer.login,(.commit.message|split("\n")[0])]|@tsv' 2>/dev/null || true)"
    if [[ "$head" =~ ^2$'\t'[^$'\t']+$'\t'web-flow$'\t'Merge\ branch\ \'main\'\ into\  ]]; then
      echo "Head — слияние main (update-branch, бот): метка review-approved остаётся."
      ACTION=""
    else
      gh api -X DELETE "repos/$REPO/issues/$PR/labels/review-approved" >/dev/null 2>&1 || true
      echo "Новый push после ревью — метка review-approved снята, нужно повторное ревью."
      LABELS="$(grep -v '^review-approved$' <<<"${LABELS:-}" || true)"
    fi
  fi
fi

report_status() {
  local state="$1"
  local desc="$2"
  if [[ -z "$SHA" ]]; then
    return 0
  fi
  # Commit statuses (ruleset & legacy status checks)
  gh api -X POST "repos/$REPO/statuses/$SHA" -f state="$state" -f context='hot-files-review' -f description="$desc" >/dev/null 2>&1 || true
  gh api -X POST "repos/$REPO/statuses/$SHA" -f state="$state" -f context='hot files review' -f description="$desc" >/dev/null 2>&1 || true

  # Check runs (branch protection context: "hot files review", ruleset context: "hot-files-review")
  # Only post check-runs on terminal state (success/failure/error).
  # Pending state is communicated via commit status so we don't leave an in-progress check-run
  # that prevents CI snapshot from completing before review.
  if [[ "$state" == "success" || "$state" == "failure" || "$state" == "error" ]]; then
    local check_conclusion="success"
    if [[ "$state" != "success" ]]; then
      check_conclusion="failure"
    fi
    gh api -X POST "repos/$REPO/check-runs" \
      -f name='hot files review' \
      -f head_sha="$SHA" \
      -f status="completed" \
      -f conclusion="$check_conclusion" \
      -f 'output[title]=Hot files review' \
      -f "output[summary]=$desc" >/dev/null 2>&1 || true

    gh api -X POST "repos/$REPO/check-runs" \
      -f name='hot-files-review' \
      -f head_sha="$SHA" \
      -f status="completed" \
      -f conclusion="$check_conclusion" \
      -f 'output[title]=Hot files review' \
      -f "output[summary]=$desc" >/dev/null 2>&1 || true
  fi
}

if [[ "$EVENT" == "merge_group" ]]; then
  echo "Событие merge_group: очередь проверяет кандидатный коммит; ревью обеспечено на PR."
  report_status 'success' 'merge queue: review enforced on the PR'
  exit 0
fi

if [[ -z "$PR" ]]; then
  # On push to main or manual dispatch, hot-files-review check is not applicable.
  exit 0
fi

if [[ -z "$SHA" ]]; then
  SHA="$(gh api "repos/$REPO/pulls/$PR" --jq '.head.sha' 2>/dev/null || true)"
fi

files="$(gh api --paginate "repos/$REPO/pulls/$PR/files" --jq '.[].filename' 2>/dev/null || true)"
if [[ -z "$files" ]]; then
  echo "Список файлов пуст или не получен от API."
  exit 0
fi

hot='^(server/src/services/heartbeat\.ts|server/src/services/execution-continuation\.ts|server/src/services/legacy-execution-recovery\.ts|server/src/services/tool-gateway\.ts|server/src/routes/tool-gateway\.ts|server/src/services/redaction\.ts|server/src/services/native-runtime/runtime-context\.ts|server/src/services/issues\.ts|server/src/routes/issues\.ts|server/src/services/chat-channels\.ts|packages/adapters/hermes/.*|packages/db/.*|scripts/myrmidon/deploy/.*|server/src/myrmidon/bot-containers/(docker-driver|template|ustar|routes)\.ts|server/src/myrmidon/agent-self-update\.ts|tools/dockergate/.*|docker/dockergate/.*|scripts/myrmidon/dockergate/.*|Dockerfile|\.github/workflows/.*)$'
touched="$(grep -E "$hot" <<<"$files" || true)"

if [[ "$ACTION" == "synchronize" && -n "$SHA" ]]; then
  head="$(gh api "repos/$REPO/commits/$SHA" --jq '[(.parents|length),.author.login,.committer.login,(.commit.message|split("\n")[0])]|@tsv' 2>/dev/null || true)"
  if [[ "$head" =~ ^2$'\t'[^$'\t']+$'\t'web-flow$'\t'Merge\ branch\ \'main\'\ into\  ]]; then
    echo "Head — слияние main (update-branch, бот): метка review-approved остаётся."
  else
    gh api -X DELETE "repos/$REPO/issues/$PR/labels/review-approved" >/dev/null 2>&1 || true
    echo "Новый push после ревью — метка review-approved снята, нужно повторное ревью."
    LABELS="$(grep -v '^review-approved$' <<<"${LABELS:-}" || true)"
  fi
fi

if [[ -z "$touched" ]]; then
  echo "Ключевые файлы не затронуты — ревью не обязательно."
  report_status 'success' 'no hot files touched'
  exit 0
fi

echo "Затронуты ключевые файлы:"
echo "$touched"

if [[ -z "$LABELS" ]]; then
  LABELS="$(gh api "repos/$REPO/issues/$PR/labels" --jq '.[].name' 2>/dev/null || true)"
  if [[ "$ACTION" == "synchronize" ]]; then
    LABELS="$(grep -v '^review-approved$' <<<"$LABELS" || true)"
  fi
fi

if grep -qx 'review-approved' <<<"$LABELS"; then
  echo "Метка review-approved есть — ревью пройдено."
  report_status 'success' 'review-approved'
else
  echo "PR трогает ключевые файлы ядра: нужна метка review-approved после ревью."
  report_status 'pending' 'waiting for review-approved'
fi
