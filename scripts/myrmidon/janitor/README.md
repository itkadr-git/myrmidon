# Myrmidon /tmp Janitor & Policy (OPE-7773)

This directory provides the host-level janitor script, systemd service and timer units, and configuration guidelines for managing `/tmp` hygiene on the host (`vm-core`) and agent containers.

## 1. Overview & Root Cause

Temporary files and orphaned profiles accumulate in `/tmp` from several sources:
- `chr-*`: Chromium user data directories created by browser and computer-use agent tasks.
- `native-*`: Session workspaces and temporary state from native-mode agent executions.
- `mdep-*`: Deployment staging files and unpack directories.
- `myrmidon-install-test-*`: Test sandboxes generated during automated installer test runs.

Blanket pruning (such as `systemd-tmpfiles -d /tmp`) is **prohibited** because live agent profiles (e.g. long-running profiles such as `claude-1002` that may be older than 24 hours) must remain active and intact.

## 2. Product Policy

1. **Run-Scoped Scratch**:
   - Agent browser profiles are routed into a run-scoped directory (`$PAPERCLIP_SCRATCH_DIR/run-dir`), exposed via `PAPERCLIP_RUN_DIR` and `CHROME_USER_DATA_DIR`.
   - On run exit, `cleanupHeartbeatRunScratch` automatically reclaims the entire run scratch directory including `run-dir`.
2. **Installer Sandbox Cleanup**:
   - `scripts/myrmidon/install/install.test.mjs` allocates sandboxes inside the scratch tree and registers an `afterEach` hook to ensure immediate cleanup.
   - `scripts/myrmidon/install/install.sh` registers a trap to clean up the temporary release manifest (`MANIFEST="$(mktemp)"`) on script exit or interruption.

## 3. Host Janitor Script (`myrmidon-tmp-janitor.sh`)

`myrmidon-tmp-janitor.sh` runs periodically on the host to prune orphaned temporary entries:
- **Strict Whitelist**: Only matches items matching `chr-*`, `native-*`, `mdep-*`, and `myrmidon-install-test-*`. All other files and directories are ignored.
- **TTL Enforcement**: Only deletes items whose modification time (`mtime`) is older than the configured TTL (positive integer in minutes, default: 60). Invalid or non-numeric/zero TTL values fail validation immediately.
- **Live Profile Protection**: Specifically excludes `claude-*` (such as `claude-1002`).
- **Recursive Process Activity Check**: Uses `lsof` with recursive inspection (`lsof -w +D <path>`) as the guaranteed tool, with fallback to Linux `/proc` filesystem traversal (`/proc/[0-9]*/fd/*`, `/proc/[0-9]*/cwd`, `/proc/[0-9]*/exe`).
- **Fail-Closed Safety**: If process activity cannot be verified safely or no inspection tool is available, the janitor safely fails closed (preserves candidate entries and logs a warning instead of deleting).

### Usage

```bash
# Clean /tmp with default 60-minute TTL
/opt/myrmidon/scripts/myrmidon/janitor/myrmidon-tmp-janitor.sh

# Custom target and TTL (must be positive integer)
/opt/myrmidon/scripts/myrmidon/janitor/myrmidon-tmp-janitor.sh --target /tmp --ttl-minutes 120

# Dry-run mode (inspect candidates without deleting)
/opt/myrmidon/scripts/myrmidon/janitor/myrmidon-tmp-janitor.sh --dry-run
```

## 4. Systemd Timer Setup

To schedule the janitor hourly:

```bash
# Copy systemd units
sudo cp /opt/myrmidon/scripts/myrmidon/janitor/myrmidon-tmp-janitor.service /etc/systemd/system/
sudo cp /opt/myrmidon/scripts/myrmidon/janitor/myrmidon-tmp-janitor.timer /etc/systemd/system/

# Reload systemd and enable timer
sudo systemctl daemon-reload
sudo systemctl enable --now myrmidon-tmp-janitor.timer

# Verify timer status
systemctl list-timers myrmidon-tmp-janitor.timer
```

## 5. Host `/tmp` Mount Sizing (fstab)

To prevent runaway disk usage and bound host memory impact, it is recommended to configure `/tmp` with a dedicated `size=8G` limit in `/etc/fstab` (instead of unlimited or 35G):

```fstab
tmpfs /tmp tmpfs rw,nosuid,nodev,noexec,size=8G 0 0
```

To apply without rebooting:

```bash
sudo mount -o remount,size=8G /tmp
```
