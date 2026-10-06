#!/usr/bin/env bash
# scripts/myrmidon/deploy/git-objects-live-acceptance.sh
#
# LIVE ACCEPTANCE of the shared git-object store (myrmidon 1.6.5, BOT-DISK-G —
# parent OPE-5281: "the bots' section is at 95 % because every clone copies the
# whole history"). Run this ON THE BOARD HOST, against ONE live bot container.
#
#   git-objects-live-acceptance.sh --list
#   git-objects-live-acceptance.sh --bot <container> [--repo <clone-url>]
#       [--hermes-home /data/hermes] [--store <path>]
#       [--max-clone-git-mb 20] [--min-store-mb 100] [--keep] [--dry-run]
#
# Why a script and not the board's own facts: the board-side telemetry (the
# entrypoint's `storeState` in git-objects-check.json, the reporter's `gitStore`
# and GET /api/myrmidon/agents/:id/bot-container/git-store) only exists once the
# 1.6.5 bot image is on the host. This is the MANUAL fallback procedure for the
# window before that: it needs docker and one running bot, nothing else.
#
# What it proves — the parent's acceptance criteria, in this order:
#   1. the store is NOT empty: after the first clone it holds the repository's
#      mirror (STORE_MIRRORS >= 1) and its allocated size is at least
#      --min-store-mb (default 100 MiB; the myrmidon repo's store is ~145 MiB);
#   2. the SECOND clone borrows from it: .git is a fraction of the first one's
#      (at most --max-clone-git-mb, default 20 MiB) and carries
#      .git/objects/info/alternates naming a path inside the store. That is the
#      fact the 06.10 incident lacked.
#
# Both clones run inside the bot container, in a scratch directory under /tmp
# removed afterwards (--keep leaves it in place for inspection), so the check
# costs one clone's network traffic and no bot disk.
#
# The same two facts are readable without an exec once the image is live:
#   docker exec <bot> sh -c 'cat $HERMES_HOME/.myrmidon/git-objects-check.json'
#   curl -sH "Authorization: Bearer $API_KEY" \
#     "$BOARD/api/myrmidon/agents/<agentId>/bot-container/git-store"
#
# Exit codes: 0 = accepted; 1 = acceptance failed (each failed criterion is
# printed with FAIL); 2 = usage or transport error (no docker, container not
# running, unexpected answer from the bot).
set -euo pipefail

log() { printf '[git-store-acceptance] %s\n' "$*" >&2; }
pass() { printf 'PASS  %s\n' "$*"; }
fail() { printf 'FAIL  %s\n' "$*"; failed=1; }
warn() { printf 'WARN  %s\n' "$*"; }
die() { printf '[git-store-acceptance] ERROR: %s\n' "$*" >&2; exit 2; }

bot="" repo="https://github.com/itkadr-git/myrmidon.git"
hermes_home="/data/hermes" store="" max_clone_git_mb=20 min_store_mb=100
keep=0 dry_run=0 list_only=0 failed=0

while (($#)); do
  case "$1" in
    --bot) bot="${2:-}"; shift 2 ;;
    --repo) repo="${2:-}"; shift 2 ;;
    --hermes-home) hermes_home="${2:-}"; shift 2 ;;
    --store) store="${2:-}"; shift 2 ;;
    --max-clone-git-mb) max_clone_git_mb="${2:-}"; shift 2 ;;
    --min-store-mb) min_store_mb="${2:-}"; shift 2 ;;
    --keep) keep=1; shift ;;
    --dry-run) dry_run=1; shift ;;
    --list) list_only=1; shift ;;
    -h|--help) sed -n '2,39p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

command -v docker >/dev/null 2>&1 || die "docker is not on PATH: run this on the board host"
[[ "${max_clone_git_mb}" =~ ^[0-9]+$ ]] || die "--max-clone-git-mb must be a number of MiB"
[[ "${min_store_mb}" =~ ^[0-9]+$ ]] || die "--min-store-mb must be a number of MiB"
[[ -n "${hermes_home}" ]] || die "--hermes-home must not be empty"
store="${store:-${hermes_home}/.myrmidon/git-objects}"

# The bot containers of this host: the deploy names them after the bot key.
bot_candidates() {
  docker ps --format '{{.Names}}' 2>/dev/null | grep -E 'bot' | sort || true
}

if ((list_only)); then
  candidates="$(bot_candidates)"
  [[ -n "${candidates}" ]] || die "no running container looks like a bot on this host (docker ps is empty of 'bot' names)"
  printf '%s\n' "${candidates}"
  exit 0
fi

if [[ -z "${bot}" ]]; then
  candidates="$(bot_candidates)"
  count="$(printf '%s\n' "${candidates}" | grep -c . || true)"
  ((count == 1)) || die "several (or no) bot containers on this host: pass --bot <container> (candidates: $(printf '%s' "${candidates}" | tr '\n' ' '))"
  bot="${candidates}"
fi

docker inspect --format '{{.State.Running}}' "${bot}" >/dev/null 2>&1 \
  || die "no container named ${bot} on this host (try --list)"
[[ "$(docker inspect --format '{{.State.Running}}' "${bot}")" == "true" ]] || die "container ${bot} is not running"

# The whole check runs as one script inside the bot: the facts come back as
# KEY=VALUE lines on stdout, so nothing here parses the bot's file system.
# The body is single-quoted on purpose: the bot's own shell expands it when the
# check runs inside the container, not this one.
# shellcheck disable=SC2016  # single-quoted on purpose: the bot's shell expands it, not this one
remote_script='set -u
d=$(mktemp -d /tmp/git-store-acceptance.XXXXXX) || exit 1
if [ "${KEEP:-0}" != "1" ]; then trap "rm -rf \"$d\"" EXIT; fi
printf "SCRATCH=%s\n" "$d"
if ! command -v git >/dev/null 2>&1; then printf "ERROR=git-not-found\n"; exit 0; fi
if ! git clone --quiet "$REPO" "$d/gc1" >/dev/null 2>&1; then printf "CLONE1=FAIL\n"; exit 0; fi
if ! git clone --quiet "$REPO" "$d/gc2" >/dev/null 2>&1; then printf "CLONE2=FAIL\n"; exit 0; fi
printf "CLONE1_KB=%s\n" "$(du -sk "$d/gc1/.git" | cut -f1)"
printf "CLONE2_KB=%s\n" "$(du -sk "$d/gc2/.git" | cut -f1)"
printf "ALTERNATES=%s\n" "$(head -n1 "$d/gc2/.git/objects/info/alternates" 2>/dev/null)"
printf "STORE=%s\n" "$STORE"
printf "STORE_KB=%s\n" "$(du -sk "$STORE" 2>/dev/null | cut -f1)"
for m in $(find "$STORE" -mindepth 2 -maxdepth 2 -type d -name "*.git" 2>/dev/null); do
  [ -d "$m/objects" ] && [ -f "$m/HEAD" ] || continue
  printf "MIRROR=%s\n" "${m#"$STORE"/}"
done
exit 0'

exec_args=(exec -e "REPO=${repo}" -e "STORE=${store}" -e "KEEP=${keep}")
if ((dry_run)); then
  log "dry run: no clone, no store write"
  printf 'docker %s %s sh -c %s\n' "${exec_args[*]}" "${bot}" "<the check script>"
  exit 0
fi

log "bot ${bot}: cloning ${repo} twice, store ${store}"
if ! out="$(docker "${exec_args[@]}" "${bot}" sh -c "${remote_script}" 2>&1)"; then
  printf '%s\n' "${out}" >&2
  die "the check could not run inside ${bot}: docker exec failed"
fi
printf '%s\n' "${out}" | grep -v '^SCRATCH=' >&2

field() { printf '%s\n' "${out}" | sed -n "s/^$1=//p" | head -n1; }
mirrors="$(printf '%s\n' "${out}" | sed -n 's/^MIRROR=//p')"
mirror_count="$(printf '%s\n' "${mirrors}" | grep -c . || true)"
clone1_kb="$(field CLONE1_KB)"; clone2_kb="$(field CLONE2_KB)"
alternates="$(field ALTERNATES)"; store_kb="$(field STORE_KB)"

[[ "$(field ERROR)" != "git-not-found" ]] || die "no git inside ${bot}: the bot image is not the 1.6.5 bot image"
[[ "$(field CLONE1)" != "FAIL" ]] || die "the first clone failed inside ${bot}: check the bot's network and the GitHub token"
[[ "$(field CLONE2)" != "FAIL" ]] || die "the second clone failed inside ${bot}: the shared store is broken on this bot"
[[ -n "${clone1_kb}" && -n "${clone2_kb}" ]] || die "the check produced no sizes inside ${bot}: unexpected answer (${clone1_kb:-none}/${clone2_kb:-none})"

mib() { awk -v kb="$1" 'BEGIN { printf "%.1f", kb / 1024 }'; }
log "first clone .git $(mib "${clone1_kb}") MiB, second $(mib "${clone2_kb}") MiB, store $(mib "${store_kb:-0}") MiB, mirrors ${mirror_count}"

# 1. The store is not empty: the myrmidon mirror is there and has weight.
if ((mirror_count >= 1)); then
  pass "store holds ${mirror_count} mirror(s): $(printf '%s' "${mirrors}" | tr '\n' ' ')"
else
  fail "store ${store} holds no mirror after the first clone — this is exactly the 06.10 state (every clone copies the whole history)"
fi
if [[ -n "${store_kb}" ]] && ((store_kb >= min_store_mb * 1024)); then
  pass "store is $(mib "${store_kb}") MiB (>= ${min_store_mb} MiB)"
else
  fail "store is $(mib "${store_kb:-0}") MiB, below the required ${min_store_mb} MiB: it holds no usable objects"
fi

# 2. The second clone borrows from it.
if [[ -n "${alternates}" ]]; then
  pass "second clone has .git/objects/info/alternates -> ${alternates}"
else
  fail "second clone has no .git/objects/info/alternates: it did not borrow the store's objects"
fi
if ((clone2_kb <= max_clone_git_mb * 1024)); then
  pass "second clone .git is $(mib "${clone2_kb}") MiB (<= ${max_clone_git_mb} MiB)"
else
  fail "second clone .git is $(mib "${clone2_kb}") MiB, above the required ${max_clone_git_mb} MiB"
fi
# The ratio is the strong form of the same fact: a borrowing clone is a small
# fraction of a full one. A store that is large but not borrowed from passes the
# absolute size only — say so instead of accepting it silently.
if ((clone2_kb * 4 <= clone1_kb)); then
  pass "second clone is under a quarter of the first ($(mib "${clone2_kb}") vs $(mib "${clone1_kb}") MiB)"
else
  warn "second clone is $(mib "${clone2_kb}") of the first clone's $(mib "${clone1_kb}") MiB: check that alternates names THIS bot's store"
fi

if ((failed)); then
  printf 'NOT ACCEPTED — %s\n' "the shared git-object store does not work on ${bot} (see the FAIL lines)"
  exit 1
fi
printf 'ACCEPTED — shared git-object store works on %s\n' "${bot}"