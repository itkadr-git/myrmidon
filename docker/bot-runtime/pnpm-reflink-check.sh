#!/bin/sh
# docker/bot-runtime/pnpm-reflink-check.sh
#
# myrmidon(BOT-DISK-H8b): proves that pnpm reflink-imports an installed package
# from its store instead of copying it, from EVERY clone root of a bot. With
# package-import-method=clone pnpm runs `cp --reflink` (FICLONE), which needs
# both the store and the project on one copy-on-write filesystem (and one
# superblock): EXDEV across filesystems, EOPNOTSUPP where the filesystem has no
# reflinks. pnpm then falls back to copying, silently — THIS script is what
# tells a reflink from a full copy.
#
# For each root it installs a local tarball package offline (no registry, no
# network) into a project under a temporary directory in that root, with the
# store at STORE_DIR, and prints one line per root:
#
#   root=<root> shared=<yes|no|unknown> samefile=<yes|no>
#
# shared=yes means filefrag(1) found at least one physical extent common to the
# installed file and the store file (a real reflink); shared=no means a full
# copy; shared=unknown means filefrag is unavailable or returned nothing and
# only samefile (a hard link) could be checked. `root=<root> install-failed`
# means the install itself did not run.
#
# The negative case: point STORE_DIR at another superblock (tmpfs, a loop
# device); every root then prints shared=no and the CI caller fails the build.
# Where the runner cannot create a second filesystem, that negative test is
# skipped with its reason, never silently green.
#
# Environment: PNPM (the pnpm to run, default `pnpm`); ROOTS (space separated
# clone roots; default: the system temporary directory); STORE_DIR (the store;
# default: a directory beside the project, in the first root); WORK_PARENT
# (legacy name of a single root). Exit status: 0 when every install ran,
# 1 otherwise (a copy is not a failure of the script; the caller reads the
# lines).
set -eu

PNPM="${PNPM:-pnpm}"
roots="${ROOTS:-${WORK_PARENT:-${TMPDIR:-/tmp}}}"
status=0
first=""
store_made=""

has_filefrag=0
command -v filefrag >/dev/null 2>&1 && has_filefrag=1

# physical extents of $1, one per line (empty when filefrag cannot answer)
extents_of() {
  filefrag -v "$1" 2>/dev/null | sed -n 's/^[[:space:]]*[0-9]*:[[:space:]]*[0-9]*\.\.[0-9]*:[[:space:]]*\([0-9][0-9]*\)\.\..*/\1/p'
}

for root in $roots; do
  [ -n "$first" ] || first="$root"
  work="$(mktemp -d "$root/pnpm-reflink.XXXXXX")" || { echo "root=$root install-failed"; status=1; continue; }
  store="${STORE_DIR:-$first/.pnpm-store-check}"
  [ -n "$store_made" ] || { mkdir -p "$store"; store_made=1; }
  mkdir -p "$work/fixture/package" "$work/ws/app" "$work/home"
  printf '{"name":"reflink-fixture","version":"1.0.0"}\n' > "$work/fixture/package/package.json"
  # Large enough that a copy is plainly a copy, and unique per run.
  { head -c 65536 /dev/zero | tr '\0' 'x'; printf '%s\n' "$work"; } > "$work/fixture/package/payload.txt"
  tar -czf "$work/ws/app/reflink-fixture.tgz" -C "$work/fixture" package
  printf '{"name":"app","version":"1.0.0","private":true,"dependencies":{"reflink-fixture":"file:./reflink-fixture.tgz"}}\n' > "$work/ws/app/package.json"

  if ! (
    cd "$work/ws/app"
    HOME="$work/home" npm_config_store_dir="$store" npm_config_package_import_method=clone \
      "$PNPM" install --offline --ignore-scripts --no-frozen-lockfile --reporter=silent >/dev/null 2>&1
  ); then
    echo "root=$root install-failed"
    status=1
    rm -rf "$work"
    continue
  fi

  installed="$work/ws/app/node_modules/reflink-fixture/payload.txt"
  if [ ! -f "$installed" ]; then
    echo "root=$root install-failed"
    status=1
    rm -rf "$work"
    continue
  fi

  # The payload is unique per run, so its byte string names exactly one store
  # file. pnpm's index files are binary and safe to skip; we search regular
  # files of at least the payload's size.
  marker="$(tail -c 100 "$installed")"
  store_file=""
  if [ -d "$store" ]; then
    store_file="$(find "$store" -type f -size +60k 2>/dev/null | while IFS= read -r f; do
      if tail -c 100 "$f" 2>/dev/null | grep -qF "$marker"; then printf '%s\n' "$f"; break; fi
    done | head -n 1)"
  fi

  same=no
  if [ -n "$store_file" ] && [ "$(stat -c '%d:%i' "$installed")" = "$(stat -c '%d:%i' "$store_file")" ]; then same=yes; fi

  shared=unknown
  if [ "$has_filefrag" -eq 1 ] && [ -n "$store_file" ] && [ "$same" = no ]; then
    src_phys="$(extents_of "$store_file")"
    dst_phys="$(extents_of "$installed")"
    if [ -n "$src_phys" ] && [ -n "$dst_phys" ]; then
      shared=no
      for phys in $src_phys; do
        case " $dst_phys " in *" $phys "*) shared=yes; break ;; esac
      done
    fi
  elif [ "$same" = yes ]; then
    # A hard link shares all extents by construction.
    shared=yes
  fi
  echo "root=$root shared=$shared samefile=$same"
  rm -rf "$work"
done

# A store the script made itself (no STORE_DIR) is removed again.
if [ -z "${STORE_DIR:-}" ] && [ -n "$first" ]; then rm -rf "$first/.pnpm-store-check"; fi
exit "$status"
