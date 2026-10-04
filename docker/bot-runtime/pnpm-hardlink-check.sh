#!/bin/sh
# docker/bot-runtime/pnpm-hardlink-check.sh
#
# myrmidon(1.6.2 BOT-DISK-C): proves that pnpm hard-links an installed package
# to its store instead of copying it. link(2) cannot cross a mount, so the
# answer depends only on whether the project and the store share one: a store
# next to the project (the bot default, /workspace/.pnpm-store beside the
# clones) gives hard links, a store on another mount gives copies.
#
# Installs a local tarball package offline (no registry, no network) into a
# project under a temporary directory and prints one line:
#
#   nlink=<link count of the installed file> samefile=<yes|no>
#
# nlink >= 2 with samefile=yes means a hard link into the store; nlink=1 means
# a copy. Environment: PNPM (the pnpm to run, default `pnpm`), STORE_DIR (a
# store location; default: beside the project, on the same mount),
# WORK_PARENT (where the project lives; default: the system temporary
# directory). Exit status is 0 when the install ran, 1 when it did not.
set -eu

PNPM="${PNPM:-pnpm}"
parent="${WORK_PARENT:-${TMPDIR:-/tmp}}"
work="$(mktemp -d "$parent/pnpm-hardlink.XXXXXX")"
trap 'rm -rf "$work"' EXIT

store="${STORE_DIR:-$work/ws/.pnpm-store}"
mkdir -p "$work/fixture/package" "$work/ws/app" "$work/home"
printf '{"name":"hardlink-fixture","version":"1.0.0"}\n' > "$work/fixture/package/package.json"
# Large enough that a copy is plainly a copy, and unique per run.
{ head -c 65536 /dev/zero | tr '\0' 'x'; printf '%s\n' "$work"; } > "$work/fixture/package/payload.txt"
tar -czf "$work/ws/app/hardlink-fixture.tgz" -C "$work/fixture" package
printf '{"name":"app","version":"1.0.0","private":true,"dependencies":{"hardlink-fixture":"file:./hardlink-fixture.tgz"}}\n' > "$work/ws/app/package.json"

(
  cd "$work/ws/app"
  HOME="$work/home" npm_config_store_dir="$store" npm_config_package_import_method=hardlink \
    "$PNPM" install --offline --ignore-scripts --no-frozen-lockfile --reporter=silent >/dev/null
) || { echo "pnpm install failed" >&2; exit 1; }

installed="$work/ws/app/node_modules/hardlink-fixture/payload.txt"
[ -f "$installed" ] || { echo "installed file missing" >&2; exit 1; }
links="$(stat -c %h "$installed")"
same=no
if [ -d "$store" ] && [ -n "$(find "$store" -type f -samefile "$installed" 2>/dev/null | head -n 1)" ]; then same=yes; fi
echo "nlink=$links samefile=$same"
