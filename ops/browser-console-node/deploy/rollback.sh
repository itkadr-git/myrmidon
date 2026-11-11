#!/usr/bin/env bash
# myrmidon(BROWSER-CONSOLE): roll the screen node back (part B).
#
# Stops the node (and with it the screen units it still owns), restores the
# newest backup from /var/backups/myrmidon/browser-console-node/<ts>/ — or
# removes the unit and the node code entirely when no backup exists (the
# node was never there). The environment file is left in place: it is a
# release artifact, not build output.
set -euo pipefail

UNIT_NAME="browser-console-node.service"
UNIT_DIR="/etc/systemd/system"
NODE_DIR="/opt/myrmidon/browser-console-node"
BACKUP_ROOT="/var/backups/myrmidon/browser-console-node"

if [[ "$(id -u)" != "0" ]]; then
  echo "rollback must run as root" >&2
  exit 1
fi

systemctl stop "$UNIT_NAME" 2>/dev/null || true
systemctl disable "$UNIT_NAME" 2>/dev/null || true
# Any screen unit the node started but did not release (crash window):
for unit in $(systemctl list-units --all --no-legend 'browser-screen-x11vnc@*' --plain 2>/dev/null | awk '{print $1}'); do
  systemctl stop "$unit" 2>/dev/null || true
done

LATEST="$(ls -1d "$BACKUP_ROOT"/*/ 2>/dev/null | sort | tail -1 || true)"
if [[ -n "${LATEST:-}" ]]; then
  rm -rf "$NODE_DIR"; mkdir -p "$NODE_DIR"
  if [[ -f "$LATEST/$UNIT_NAME" ]]; then
    install -m 0644 "$LATEST/$UNIT_NAME" "$UNIT_DIR/$UNIT_NAME"
  else
    rm -f "$UNIT_DIR/$UNIT_NAME"
  fi
  if [[ -d "$LATEST/node-dir" ]]; then
    cp -a "$LATEST/node-dir/." "$NODE_DIR/"
  fi
  echo "restored from $LATEST"
else
  rm -f "$UNIT_DIR/$UNIT_NAME"
  rm -rf "$NODE_DIR"
  echo "no backup found — the unit and $NODE_DIR were removed"
fi

systemctl daemon-reload
echo "rolled back. restart the board-side settings if the node address changed."
