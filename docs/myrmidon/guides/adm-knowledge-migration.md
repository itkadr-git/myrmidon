# ADM knowledge migration guide (OPE-9263)

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

## Русский
Команда dry-run: `node scripts/myrmidon/adm-migrate.mjs SOURCE_ROOT`. Анализирует `CLAUDE.md` и плоский каталог `memory/`. Исходные файлы не изменяются.

Отчёт dry-run включает:
- `manifest`: пути и SHA-256 хеши исходных файлов.
- `report.counts`: распределение по категориям (`rule`, `trigger`, `reference`, `lesson`, `skill_card`).
- `report.conflicts`: конфликты slug или содержимого.
- `report.oversized`: документы, превышающие допустимый размер.
- `report.unrecognized`: файлы, не найденные в индексе `MEMORY.md` и не имеющие `migration_kind`.
- `report.missingSummary`: политики и триггеры без `description:` в frontmatter (фиксируются в отчёте без прерывания).
- `report.redactions`: вырезка и карантин секретов через gitleaks.
- `report.secretsRemaining`: число оставшихся секретов (0 для успешного прогона).
- `report.sessionStartBytes` / `report.sessionStartLimit`: проверка лимита SessionStart (<= 12 КБ).

Классификация берётся из индекса `MEMORY.md` (`## Политики — всегда` и др.). Каталог `_archive/` автоматически исключается из обхода. Проверка секретов использует gitleaks с валидацией контрольной суммы.
