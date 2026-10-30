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

if [[ "$EVENT" == "merge_group" ]]; then
  echo "Событие merge_group: очередь проверяет кандидатный коммит; ревью обеспечено на PR."
  if [[ -n "$SHA" ]]; then
    gh api -X POST "repos/$REPO/statuses/$SHA" -f state='success' -f context='hot-files-review' -f description='merge queue: review enforced on the PR' >/dev/null 2>&1 || true
  fi
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

if [[ -z "$touched" ]]; then
  echo "Ключевые файлы не затронуты — ревью не обязательно."
  if [[ -n "$SHA" ]]; then
    gh api -X POST "repos/$REPO/statuses/$SHA" -f state='success' -f context='hot-files-review' -f description='no hot files touched' >/dev/null 2>&1 || true
  fi
  exit 0
fi

echo "Затронуты ключевые файлы:"
echo "$touched"

if [[ "$ACTION" == "synchronize" && -n "$SHA" ]]; then
  head="$(gh api "repos/$REPO/commits/$SHA" --jq '[(.parents|length),.author.login,.committer.login,(.commit.message|split("\n")[0])]|@tsv' 2>/dev/null || true)"
  if [[ "$head" =~ ^2$'\t'[^$'\t']+\[bot\]$'\t'web-flow$'\t'Merge\ branch\ \'main\'\ into\  ]]; then
    echo "Head — слияние main (update-branch, бот): метка review-approved остаётся."
  else
    gh api -X DELETE "repos/$REPO/issues/$PR/labels/review-approved" >/dev/null 2>&1 || true
    echo "Новый push после ревью — метка review-approved снята, нужно повторное ревью."
    LABELS=""
  fi
fi

if [[ -z "$LABELS" ]]; then
  LABELS="$(gh api "repos/$REPO/issues/$PR/labels" --jq '.[].name' 2>/dev/null || true)"
fi

if grep -qx 'review-approved' <<<"$LABELS"; then
  echo "Метка review-approved есть — ревью пройдено."
  if [[ -n "$SHA" ]]; then
    gh api -X POST "repos/$REPO/statuses/$SHA" -f state='success' -f context='hot-files-review' -f description='review-approved' >/dev/null 2>&1 || true
  fi
else
  echo "PR трогает ключевые файлы ядра: нужна метка review-approved после ревью."
  if [[ -n "$SHA" ]]; then
    gh api -X POST "repos/$REPO/statuses/$SHA" -f state='pending' -f context='hot-files-review' -f description='waiting for review-approved' >/dev/null 2>&1 || true
  fi
fi
