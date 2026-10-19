package policy

// The two scripts that a helper container runs. They are byte-for-byte the
// scripts of server/src/myrmidon/bot-containers/docker-driver.ts (the contract
// tests compare them with the output of the driver's own modules for several
// nonces); dockergate refuses a create body whose Cmd[0] differs from them by
// one character.
//
// Invariants of PrepareScript (a helper that runs as root, RT1-2):
//
//  1. The text is a constant. It contains no recursion (-R), no symlink option
//     (-L, -H), no find, no xargs and no glob, so nothing that lives in the
//     bot's directories can change what it touches.
//  2. It touches exactly four volume paths: the mount points of the bind mounts
//     (data/hermes, workspace, scratch), each with one chmod and one chown, and
//     the bot's root bind (/bot, BOT-ROOT-TRAVERSE) with one chmod. All are mount
//     points fixed by dockergate before the container is created (the volume-root
//     invariants), in a container without network, with a read-only root file
//     system and only the CHOWN and FOWNER capabilities.
//  3. When the shared package cache root is bound at the helper's fixed
//     package-cache mount (myrmidon 1.6.5-BOT-DISK-UV-B board side; the helper
//     is the only container that receives that bind), it creates every cache
//     subdirectory of the fixed list with install(1) and hands each to the
//     bot's uid — the fixed list keeps the constant-text invariant (no glob,
//     no find), and the `test -d package-cache` guard makes the step a no-op on
//     a bot without a configured cache.
//
// PrepareScript is Cmd[0] of the prepare helper.
// myrmidon(BOT-ROOT-TRAVERSE): the last line fixes traversal into the bot's root
// directory (the helper's /bot bind, the one mount the bot container gets): an
// externally imposed 0710/0700 root hid the whole tree from uid 10001 and the bot
// died on a missing API_SERVER_KEY. chmod 0711 keeps the root root-owned (the gate
// invariant) and not writable by group or others, while making it enterable; the
// content is never listed, written or chowned.
const PrepareScript = `set -eu
cd "$1"
for d in data/hermes workspace scratch; do
  chmod 0700 "$d"
  chown 10001:10001 "$d"
done
chmod 0711 bot
if test -d package-cache; then
  install -d -o 10001 -g 10001 "package-cache/pnpm"
  install -d -o 10001 -g 10001 "package-cache/pnpm-store"
  install -d -o 10001 -g 10001 "package-cache/uv"
  install -d -o 10001 -g 10001 "package-cache/go-mod"
  install -d -o 10001 -g 10001 "package-cache/go-build"
  install -d -o 10001 -g 10001 "package-cache/gradle"
fi`

// PrepareScriptShared is Cmd[0] of the prepare helper of a member of a shared
// scope instance (BOT-DISK-F). The same three paths as PrepareScript, plus the
// instance directory itself (the helper's /scope bind), which has to belong to
// the bot's uid so the container can create the instance's pnpm store there.
// Still no recursion, no link-following option, no find and no glob. The
// package-cache step is identical to PrepareScript (1.6.5-BOT-DISK-UV-B).
const PrepareScriptShared = `set -eu
cd "$1"
for d in data/hermes workspace scratch scope; do
  chmod 0700 "$d"
  chown 10001:10001 "$d"
done
if test -d package-cache; then
  install -d -o 10001 -g 10001 "package-cache/pnpm"
  install -d -o 10001 -g 10001 "package-cache/pnpm-store"
  install -d -o 10001 -g 10001 "package-cache/uv"
  install -d -o 10001 -g 10001 "package-cache/go-mod"
  install -d -o 10001 -g 10001 "package-cache/go-build"
  install -d -o 10001 -g 10001 "package-cache/gradle"
fi`

// NoncePlaceholder marks the nonce in the apply script template.
const NoncePlaceholder = "@N@"

// applyTemplate is Cmd[0] of the apply helper with the nonce replaced by
// NoncePlaceholder (five places).
const applyTemplate = `set -eu
umask 077
cd "$1"
n=@N@
# 1. staging from interrupted earlier applies
for root in data/hermes workspace scratch; do
  for stale in "$root"/.myrmidon-next-* "$root"/.myrmidon-apply-* "$root"/.myrmidon-old-*; do
    [ -e "$stale" ] || continue
    case "${stale#"$root"/}" in
      ".myrmidon-next-$n" | ".myrmidon-apply-$n") ;;
      *) rm -rf -- "$stale" ;;
    esac
  done
done
# 2. compiler-owned directories, replaced wholesale
staged="data/hermes/.myrmidon-next-$n/skills-board"
live="data/hermes/skills-board"
if [ -d "$staged" ]; then
  old="data/hermes/.myrmidon-old-$n"
  mkdir -p -- "$old"
  if [ -e "$live" ] || [ -L "$live" ]; then mv -f -T -- "$live" "$old/0"; fi
  mkdir -p -- "$(dirname -- "$live")"
  mv -f -T -- "$staged" "$live"
fi
# 3. every other staged file, one atomic rename each
list="data/hermes/.myrmidon-apply-@N@/staged.list"
for root in data/hermes workspace scratch; do
  staging="$root/.myrmidon-next-$n"
  [ -d "$staging" ] || continue
  (cd "$staging" && find . -type f) > "$list"
  while IFS= read -r rel; do
    rel="${rel#./}"
    mkdir -p -- "$(dirname -- "$root/$rel")"
    mv -f -T -- "$staging/$rel" "$root/$rel"
  done < "$list"
done
# 4. files the previous apply wrote that this profile no longer has
removals="data/hermes/.myrmidon-apply-@N@/remove.list"
if [ -f "$removals" ]; then
  while IFS= read -r p; do
    case "$p" in
      hermes/*) dest="data/hermes/${p#hermes/}" ;;
      workspace/*) dest="workspace/${p#workspace/}" ;;
      scratch/*) dest="scratch/${p#scratch/}" ;;
      *) continue ;;
    esac
    if [ -f "$dest" ] || [ -L "$dest" ]; then rm -f -- "$dest"; fi
  done < "$removals"
fi
# 4.5 vendor config backups under hermes (possible secret leak), best effort
backups="data/hermes/backups"
if [ -d "$backups" ]; then
  rm -rf -- "$backups" 2>/dev/null || true
fi
# 5. the applied-state marker, strictly last
mkdir -p -- "data/hermes/.myrmidon"
mv -f -T -- "data/hermes/.myrmidon-apply-@N@/applied.json" "data/hermes/.myrmidon/applied.json"
rm -rf -- "data/hermes/.myrmidon-next-$n" "workspace/.myrmidon-next-$n" "scratch/.myrmidon-next-$n" "data/hermes/.myrmidon-apply-@N@" "data/hermes/.myrmidon-old-$n"`
