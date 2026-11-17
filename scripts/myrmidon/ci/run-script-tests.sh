#!/usr/bin/env bash
set -euo pipefail
mapfile -t files < <(
  find scripts/myrmidon -path scripts/myrmidon/bundle-audit -prune -o -name '*.test.mjs' -type f -print
  find scripts -maxdepth 1 -name '*.myrmidon.test.mjs' -type f
)
mapfile -t files < <(printf '%s\n' "${files[@]}" | sort)
printf 'Running %s\n' "${files[@]}"
node --test "${files[@]}"
