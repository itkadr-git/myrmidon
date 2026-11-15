# ADM knowledge migration guide (OPE-9263)

> Русская версия: [Adm-knowledge-migration.ru](Adm-knowledge-migration.ru)


## Migration
`node scripts/myrmidon/adm-migrate.mjs SOURCE_ROOT` runs a deterministic dry-run analysis over legacy ADM knowledge sources (CLAUDE.md and memory/). Source files are never modified.

The dry-run report outputs JSON with:
- `manifest`: list of source paths and SHA-256 hashes.
- `report.counts`: breakdown by category (`rule`, `trigger`, `reference`, `lesson`, `skill_card`).
- `report.conflicts`: detected slug or content collisions.
- `report.oversized`: items exceeding safe body size limits.
- `report.unrecognized`: files without category in `MEMORY.md` index or explicit frontmatter.
- `report.missingSummary`: rules/triggers lacking `description:` in frontmatter (recorded in report, fail-safe without throwing).
- `report.redactions`: files containing secrets quarantined by gitleaks.
- `report.secretsRemaining`: count of residual secrets (0 required for pass).
- `report.sessionStartBytes` / `report.sessionStartLimit`: verification of SessionStart summary budget (<= 12 KiB).

Classification is driven by the `MEMORY.md` index (e.g. `## Политики — всегда` for rules, `## Триггеры` for triggers, `## Справочники` for references, `## Уроки` for lessons, `## Навыки` for skill cards) over a flat `memory/*.md` directory. The walker automatically skips `_archive/` subdirectories.

Secret scanning uses gitleaks (version >= 8.21 on PATH or configured via `ADM_GITLEAKS_BIN`). If any secret pattern is detected, the finding is quarantined and recorded.

## Verification
CI verifies migration logic via `node --test scripts/myrmidon/adm-migrate.test.mjs`:
- 235-source realistic fixture (flat `memory/*.md`, `MEMORY.md` index, 15 policies + CLAUDE.md as rules).
- Frontmatter `description:` extraction and `report.missingSummary` recording without throw.
- Walker skipping `_archive/` directory.
- `report.unrecognized` handling for unindexed files.
- Pinned gitleaks archive SHA-256 hash validation and secret quarantine.
