#!/usr/bin/env bash
# myrmidon(BROWSER-CONSOLE): install the screen node on the exec host (part B).
#
# Runs AS ROOT on the exec host. Idempotent: backs up any previous install
# (unit file or drop-in) under /var/backups/myrmidon/browser-console-node/<ts>/
# before overwriting, syntax-checks the node script, installs the unit, and
# reloads systemd. The environment file is NEVER copied from the repo — the
# operator releases it once at /etc/myrmidon/browser-console-node.env
# (root:root 0600); the install refuses to run without it.
#
# Usage: sudo install.sh [repo-ops-dir]   (default: the directory of this script)
set -euo pipefail

OPS_DIR="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
NODE_DIR="/opt/myrmidon/browser-console-node"
UNIT_DIR="/etc/systemd/system"
ENV_FILE="/etc/myrmidon/browser-console-node.env"
BACKUP_ROOT="/var/backups/myrmidon/browser-console-node"
UNIT_NAME="browser-console-node.service"

if [[ "$(id -u)" != "0" ]]; then
  echo "install must run as root (it writes /opt, /etc/systemd and /var/backups)" >&2
  exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "missing $ENV_FILE — release it first (see ops/browser-console-node/systemd/browser-console-node.env.example)" >&2
  exit 1
fi
if [[ "$(stat -c '%a' "$ENV_FILE")" != "600" || "$(stat -c '%U:%G' "$ENV_FILE")" != "root:root" ]]; then
  echo "$ENV_FILE must be root:root 0600" >&2
  exit 1
fi

TS="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$BACKUP_ROOT/$TS" "$NODE_DIR" "$UNIT_DIR"

# -- backup the previous install (unit, env untouched, node code listing) ----
if [[ -f "$UNIT_DIR/$UNIT_NAME" ]]; then
  cp -a "$UNIT_DIR/$UNIT_NAME" "$BACKUP_ROOT/$TS/$UNIT_NAME"
  echo "backed up the old unit to $BACKUP_ROOT/$TS/$UNIT_NAME"
fi
if [[ -d "$NODE_DIR" ]] && compgen -G "$NODE_DIR/*" >/dev/null; then
  cp -a "$NODE_DIR" "$BACKUP_ROOT/$TS/node-dir"
  echo "backed up the old node code to $BACKUP_ROOT/$TS/node-dir"
fi
# An x11vnc-temp.service from a manual trace: recorded, never touched.
for stray in x11vnc-temp.service; do
  if systemctl list-unit-files "$stray" --no-pager 2>/dev/null | grep -q "$stray"; then
    echo "note: $stray exists on this host (manual trace); this install does not manage it" >&2
  fi
done

# -- syntax-check the node before it can ever be ExecStart-ed ---------------
python3 -m py_compile "$OPS_DIR/node.py"
echo "node.py syntax ok"

install -m 0755 "$OPS_DIR/node.py" "$NODE_DIR/node.py"
install -m 0644 "$OPS_DIR/systemd/$UNIT_NAME" "$UNIT_DIR/$UNIT_NAME"

systemctl daemon-reload
systemctl enable "$UNIT_NAME"
echo "installed $UNIT_NAME — start it with: systemctl start $UNIT_NAME"
echo "then check the board side: MYRMIDON_BROWSER_CONSOLE_HOST points at this node,"
echo "MYRMIDON_BROWSER_CONSOLE_TOKEN equals BROWSER_CONSOLE_NODE_TOKEN."
