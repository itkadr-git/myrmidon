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

exec /usr/sbin/sshd -D -e -f /etc/ssh/omp-runner/sshd_config
