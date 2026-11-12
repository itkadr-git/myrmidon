#!/bin/sh
# myrmidon(OPE-12633 OMP-SSH-RUNNER): entrypoint of the omp SSH runner.
# Generates the host key once into its volume (the board pins it in the SSH
# environment's known hosts), refuses to start without a mounted authorized
# key, then runs sshd in the foreground under tini.
set -eu

key_dir=/var/lib/omp-runner/hostkeys
host_key="$key_dir/ssh_host_ed25519_key"
authorized_keys=/etc/ssh/omp-runner/authorized_keys

mkdir -p "$key_dir" /run/sshd
if [ ! -s "$host_key" ]; then
  ssh-keygen -q -t ed25519 -N '' -f "$host_key"
  echo "omp-runner: generated host key $(ssh-keygen -l -f "$host_key.pub")"
fi
chmod 0600 "$host_key"

if [ ! -s "$authorized_keys" ]; then
  echo "omp-runner: no authorized key at $authorized_keys; mount the board's public key there (read-only)" >&2
  exit 1
fi

# The workspace and home volumes are created by docker as root on first use.
chown 1000:1000 /workspace /home/paperclip

# myrmidon(OPE-12722 OMP-RUNNER-SHARED-CACHE): pnpm env for the runner's SSH
# sessions. sshd does not pass container environment variables to logins
# (PermitUserEnvironment no), and the board spawns every command as a fresh SSH
# session, so Dockerfile ENV never reaches them: the only channel is a profile
# file. /etc/profile.d/*.sh is sourced by /etc/profile before the board's
# `exec env KEY=VAL <cmd>` (packages/adapter-utils ssh.ts) and by the agent's
# own shells. The pnpm file is unconditional (the cache file below is written
# only when the compose file mounts a usable /cache/pnpm):
# - npm_config_store_dir=/workspace/.paperclip-runtime/pnpm-store: the pnpm
#   STORE lives in the workspace volume, one per runner — a store under /cache
#   would make pnpm copy every package into every clone, because a
#   reflink/hardlink cannot cross a filesystem boundary (BOT-DISK-D, bot-runtime
#   image). It sits inside `.paperclip-runtime`, the one directory every board
#   cleanup of the workspace spares (git clean -e, clearRemoteDirectory, the
#   post-run cleanup) and the sync never copies; a store at /workspace/.pnpm-store
#   would not have that protection (see compose.yml). pnpm creates the directory
#   itself, as uid 1000 in the chowned /workspace;
# - npm_config_package_import_method=clone-or-copy: a reflink where the
#   filesystem has them (XFS with reflink=1), else a plain copy. pnpm 9 copies
#   silently when a reflink or link is refused, whatever the method, so nothing
#   here turns a missing reflink into an error: measure the disk (README), not
#   the exit code.
cat > /etc/profile.d/omp-runner-pnpm.sh <<'PROFILE'
# Written by the omp-runner entrypoint (OPE-12722): the pnpm store lives in the
# workspace volume (one per runner), inside .paperclip-runtime, which the board's
# cleanups spare; the import is a reflink where possible, else a copy.
export npm_config_store_dir=/workspace/.paperclip-runtime/pnpm-store
export npm_config_package_import_method=clone-or-copy
PROFILE
chmod 0644 /etc/profile.d/omp-runner-pnpm.sh

# The shared download cache of the package managers (registry metadata for
# pnpm, npm's tarball/_cacache cache for npm; never the pnpm store): written
# only when the compose file mounts /cache/pnpm and uid 1000 owns it. npm and
# pnpm read different variables — pnpm the cache-dir (npm_config_cache_dir,
# it ignores npm_config_cache), npm the cache (npm_config_cache, which warns
# about the unknown cache_dir but works) — so the shared directory is exported
# under both names, and both tools' downloads land on the same shared mount
# instead of a per-runner ~/.npm. The mount is the runners' own directory
# (<cache>/pnpm-omp on the host). The hermes bots share <cache>/pnpm as uid
# 10001, and their prepare step re-owns it, so this script never chowns a
# directory that belongs to somebody else: it fixes only a root-owned one
# (docker creates a missing bind source as root), and a directory of another
# uid is reported and left alone, with npm and pnpm on their default
# per-runner cache. The file is removed first: /etc/profile.d lives in the
# container layer, which survives a plain restart.
rm -f /etc/profile.d/omp-runner-cache.sh
if [ -d /cache/pnpm ]; then
  cache_uid=$(stat -c %u /cache/pnpm)
  if [ "$cache_uid" = 0 ]; then
    chown 1000:1000 /cache/pnpm 2>/dev/null || true
    cache_uid=$(stat -c %u /cache/pnpm)
  fi
  if [ "$cache_uid" = 1000 ]; then
    cat > /etc/profile.d/omp-runner-cache.sh <<'PROFILE'
# Written by the omp-runner entrypoint (OPE-12722): the runners' shared
# download cache on the bot data disk. pnpm reads it as cache-dir
# (npm_config_cache_dir); npm reads it as cache (npm_config_cache).
export npm_config_cache_dir=/cache/pnpm
export npm_config_cache=/cache/pnpm
PROFILE
    chmod 0644 /etc/profile.d/omp-runner-cache.sh
    echo "omp-runner: shared package download cache at /cache/pnpm"
  else
    echo "omp-runner: WARNING /cache/pnpm is owned by uid $cache_uid, not 1000; not used. Mount a directory of the runners' own (<cache>/pnpm-omp), not the bots' <cache>/pnpm" >&2
  fi
fi

# The board's git mirrors, read through /usr/local/bin/git (mounted read-only):
# one line so the operator sees whether the mount holds any.
if [ -d /cache/git ]; then
  echo "omp-runner: git mirrors at /cache/git: $(find /cache/git -mindepth 2 -maxdepth 2 -type d -name '*.git' | wc -l) repositories"
fi

exec /usr/sbin/sshd -D -e -f /etc/ssh/omp-runner/sshd_config
