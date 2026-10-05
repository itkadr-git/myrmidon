#!/bin/sh
# docker/bot-runtime/pnpm-hardlink-check.sh
#
# myrmidon(BOT-DISK-D): proves that pnpm hard-links an installed package to its
# store instead of copying it, from EVERY clone root of a bot. link(2) cannot
# cross a mount, so the answer depends only on whether the project and the store
# share one. A bot container has ONE mount for its whole tree, so a store inside
# it and projects under /data/hermes, /workspace and /scratch (all resolving into
# that mount) must all give hard links.
#
# For each root it installs a local tarball package offline (no registry, no
# network) into a project under a temporary directory in that root, with the
# store at STORE_DIR, and prints one line per root:
#
#   root=<root> nlink=<link count of the installed file> samefile=<yes|no>
#
# nlink >= 2 with samefile=yes means a hard link into the store; nlink=1 means a
# copy. pnpm runs with package-import-method=hardlink, but pnpm 9 still falls back
# to copying when the kernel refuses the link (EXDEV), so the install succeeds and
# THIS script is what tells a copy from a link. `root=<root> install-failed` means
# the install itself did not run.
#
# Environment: PNPM (the pnpm to run, default `pnpm`); ROOTS (space separated clone
# roots; default: the system temporary directory); STORE_DIR (the store; default:
# a directory beside the project, in the first root); WORK_PARENT (legacy name of a
# single root). Exit status: 0 when every install ran, 1 otherwise (a copy is not a
# failure of the script; the caller reads the lines).
set -eu

PNPM="${PNPM:-pnpm}"
roots="${ROOTS:-${WORK_PARENT:-${TMPDIR:-/tmp}}}"
status=0
first=""
store_made=""

for root in $roots; do
  [ -n "$first" ] || first="$root"
  work="$(mktemp -d "$root/pnpm-hardlink.XXXXXX")" || { echo "root=$root install-failed"; status=1; continue; }
  store="${STORE_DIR:-$first/.pnpm-store-check}"
  [ -n "$store_made" ] || { mkdir -p "$store"; store_made=1; }
  mkdir -p "$work/fixture/package" "$work/ws/app" "$work/home"
  printf '{"name":"hardlink-fixture","version":"1.0.0"}\n' > "$work/fixture/package/package.json"
  # Large enough that a copy is plainly a copy, and unique per run.
  { head -c 65536 /dev/zero | tr '\0' 'x'; printf '%s\n' "$work"; } > "$work/fixture/package/payload.txt"
  tar -czf "$work/ws/app/hardlink-fixture.tgz" -C "$work/fixture" package
  printf '{"name":"app","version":"1.0.0","private":true,"dependencies":{"hardlink-fixture":"file:./hardlink-fixture.tgz"}}\n' > "$work/ws/app/package.json"

  if ! (
    cd "$work/ws/app"
    HOME="$work/home" npm_config_store_dir="$store" npm_config_package_import_method=hardlink \
      "$PNPM" install --offline --ignore-scripts --no-frozen-lockfile --reporter=silent >/dev/null 2>&1
  ); then
    echo "root=$root install-failed"
    status=1
    rm -rf "$work"
    continue
  fi

  installed="$work/ws/app/node_modules/hardlink-fixture/payload.txt"
  if [ ! -f "$installed" ]; then
    echo "root=$root install-failed"
    status=1
    rm -rf "$work"
    continue
  fi
  links="$(stat -c %h "$installed")"
  same=no
  if [ -d "$store" ] && [ -n "$(find "$store" -type f -samefile "$installed" 2>/dev/null | head -n 1)" ]; then same=yes; fi
  echo "root=$root nlink=$links samefile=$same"
  rm -rf "$work"
done

# A store the script made itself (no STORE_DIR) is removed again.
if [ -z "${STORE_DIR:-}" ] && [ -n "$first" ]; then rm -rf "$first/.pnpm-store-check"; fi
exit "$status"
