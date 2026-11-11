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

# myrmidon(OPE-12722 OMP-RUNNER-SHARED-CACHE): npm and pnpm env for the
# runner's SSH sessions. sshd does not pass container environment variables to
# logins (PermitUserEnvironment no), and the board spawns every command as a
# fresh SSH session, so Dockerfile ENV never reaches them: the only channel is
# a profile file. /etc/profile.d/*.sh is sourced by /etc/profile before the
# board's `exec env KEY=VAL <cmd>` (packages/adapter-utils ssh.ts) and by the
# agent's own shells. Everything here is unconditional (unlike /cache/pnpm,
# whose file is written only when the compose file mounts it):
# - npm_config_store_dir=/workspace/.pnpm-store: the pnpm STORE lives in the
#   workspace volume, one per runner — a store under /cache would make pnpm
#   copy every package into every clone, because a reflink/hardlink cannot
#   cross a filesystem boundary (BOT-DISK-D, bot-runtime image);
# - npm_config_package_import_method=clone: a reflink, strictly — pnpm must
#   fail loudly instead of silently copying when the kernel refuses it.
cat > /etc/profile.d/omp-runner-pnpm.sh <<'PROFILE'
# Written by the omp-runner entrypoint (OPE-12722): the pnpm store lives in
# the workspace volume (one per runner); the import is a reflink, strictly.
export npm_config_store_dir=/workspace/.pnpm-store
export npm_config_package_import_method=clone
PROFILE
chmod 0644 /etc/profile.d/omp-runner-pnpm.sh

# The shared DOWNLOAD cache (registry metadata, never the store): written only
# when the compose file mounts it. Without the mount npm keeps its default
# (rootfs ~/.npm), so a runner started without OMP_RUNNER_CACHE_DIR is
# unaffected. Guarded: the entrypoint runs with set -eu, and a root-owned
# cache dir created by docker on first use would block uid 1000.
if [ -d /cache/pnpm ]; then
  mkdir -p /cache/pnpm 2>/dev/null || true
  chown 1000:1000 /cache/pnpm 2>/dev/null || true
  cat > /etc/profile.d/omp-runner-cache.sh <<'PROFILE'
# Written by the omp-runner entrypoint (OPE-12722): the shared download cache
# on the bot data disk. npm and pnpm (which read npm_config_*) keep their
# registry metadata here instead of one copy per runner.
export npm_config_cache_dir=/cache/pnpm
PROFILE
  chmod 0644 /etc/profile.d/omp-runner-cache.sh
  echo "omp-runner: npm/pnpm download cache at /cache/pnpm"
fi

exec /usr/sbin/sshd -D -e -f /etc/ssh/omp-runner/sshd_config
