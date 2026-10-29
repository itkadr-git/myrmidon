# ADM Knowledge Connector: Staged Rollout, Kill-Switch, Rollback & Legacy Archive (v1)

This document specifies the operational procedure for staged rollout, emergency kill-switch, rollback, and legacy file archiving for the ADM knowledge connector (Contract H, OPE-9265 / OPE-9247).

---

## 1. Staged Rollout Sequence (тень → основной)

The connector operates in three distinct stages:

```
[disabled] ───(enable)───> [shadow] ───(promote)───> [main]
    ▲                         ▲                        │
    │                         │                        │
    └──(kill-switch / rollback)────────────────────────┘
```

### Stage 1: `shadow` (тень)
- **Purpose**: Low-risk operational verification in production environment.
- **Behavior**:
  - The hook runs on every Claude Code event (`SessionStart`, `UserPromptSubmit`).
  - Evaluates triggers, fetches/verifies cache, checks hard token budgets.
  - Computes candidate prompt injection and deduplicates per session.
  - Logs comprehensive metrics to `metrics.jsonl` with `"mode": "shadow"`.
  - **Zero prompt impact**: Emits **NO** `additionalContext` on `stdout`. Claude Code proceeds using existing setup without disturbance.
- **Duration**: Minimum 24 hours of operational traffic, verifying trigger match precision, budget compliance, and latency.

### Stage 2: `main` (основной)
- **Purpose**: Active knowledge injection into Claude Code prompts.
- **Behavior**:
  - Emits `additionalContext` within strict Contract A hard caps:
    - `SessionStart`: ≤12 KiB (compressed policy summaries ≤300 chars, trigger index).
    - `UserPromptSubmit`: ≤2 KiB per message (deduplicated by `slug+revision_id` per session).
  - Logs metrics to `metrics.jsonl` with `"mode": "main"`.

### Stage 0: `disabled` (выключено / kill-switch)
- **Behavior**:
  - Instant fast-path return with exit code 0.
  - Zero stdout output, zero network requests, zero file locks, zero token overhead.

---

## 2. Emergency Kill-Switch (Выключатель хуков)

If unexpected behavior, budget spikes, or latency occurs, operators can kill the connector instantly without modifying Claude Code hook configuration:

### Method A: Environment variable
```bash
export ADM_CONNECTOR_DISABLED=1
# or
export ADM_CONNECTOR_MODE=disabled
```

### Method B: File switch (touch / rm)
```bash
# Emergency kill
touch ~/.adm-connector/disabled

# Re-enable to shadow
rm -f ~/.adm-connector/disabled
```

### Method C: Management CLI
```bash
node scripts/myrmidon/adm-connector/rollout.mjs kill-switch on --reason "incident triage"
node scripts/myrmidon/adm-connector/rollout.mjs kill-switch off
```

---

## 3. Rollback Procedure (Восстановление последнего кэша без удаления знаний)

### Core Invariant
**Knowledge items on the Paperclip board are NEVER deleted during rollback.**
Rollback is an operational safety control for connector consumers and client cache, not a board data purge. Board items remain intact for forensic audit and future re-activation.

### Rollback Workflow
1. **Disable active hooks**: Rollout mode is immediately switched to `disabled` (or `shadow`).
2. **Restore cache snapshot**: The last known verified cache (`cache.backup.json` or snapshot) is atomically restored to active `cache.json` with permissions `0600`.
3. **Audit logging**: Rollback event is recorded in `rollback-audit.jsonl` with timestamp, restored cache SHA-256, and operator justification.
4. **Knowledge safety verification**: Asserts 0 delete/mutation calls against the board knowledge repository.

### Rollback Command
```bash
node scripts/myrmidon/adm-connector/rollout.mjs rollback \
  --cache-dir ~/.adm-connector \
  --backup ~/.adm-connector/cache.backup.json \
  --mode disabled
```

---

## 4. Legacy File Archiving (Старые файлы: только чтение и архив)

### Targeted Legacy Files
- `CLAUDE.md` (legacy project rules, ~10.8 KiB)
- `MEMORY.md` (legacy memory dump, ~13.4 KiB)
- `memory/` (all individual memory and policy files, 235 files, ~239 KiB)

### Archiving Rules
1. **Never delete**: Legacy files are **STRICTLY PRESERVED** in place. Deletion is deferred to a separate post-rollback deprecation task after the operational stabilization window.
2. **Read-only lockdown**: Source legacy files and archived copies are set to read-only permissions (`0444` / `0400`) to prevent accidental manual edits during the coexistence window.
3. **Cryptographic Manifest**: An immutable `manifest.json` is generated in the archive directory containing:
   - Creation timestamp
   - Total file count and total byte size
   - Path, byte size, permissions, and SHA-256 hash for every archived file.
4. **Integrity Verification**: `verifyLegacyArchive` verifies byte counts, SHA-256 checksums, and read-only flags against the manifest.
5. **Emergency Restoration**: `restoreLegacyArchive` provides verified restoration back to the working tree if a full legacy rollback is required.

### Archive Commands
```bash
# Archive legacy files
node scripts/myrmidon/adm-connector/rollout.mjs archive-legacy \
  --source /path/to/profile \
  --archive /path/to/profile/.adm-archive/$(date +%Y%m%d%H%M%S)

# Verify archive integrity
node scripts/myrmidon/adm-connector/rollout.mjs verify-archive \
  --archive /path/to/profile/.adm-archive/<timestamp>
```

---

## 5. Acceptance Verification

| Requirement | Implementation | Test Coverage |
| --- | --- | --- |
| Staged rollout (shadow → main) | `rollout.mjs`, `cli.mjs`, `hooks.mjs` | `rollout.test.mjs` |
| Hook kill-switch | Env vars, file markers, CLI | `rollout.test.mjs` |
| Rollback without deleting knowledge | `rollback()` restores cache, zero board mutations | `rollout.test.mjs` |
| Legacy files read-only & archive | `archiveLegacyFiles()`, SHA-256 manifest, no deletions | `rollout.test.mjs` |
| Token budgets (Contract A) | Hard limits: SessionStart ≤12 KiB, UserPromptSubmit ≤2 KiB | `hooks.test.mjs`, `token-benchmark.test.mjs` |
