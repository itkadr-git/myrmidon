## changelog-en

### Reference database fixtures and CI matrix for all supported vendor releases (MIGRATE-D3)

- Synthetic database fixtures and verification suites are generated for all supported Paperclip releases (`v2026.916.0`, `v2026.916.1`, `v2026.1001.0`, `v2026.1005.0`, `v2026.1012.0`) in `tests/fixtures/paperclip-migration/`.
- Each release includes schema DDL derived from vendor migration tags, non-empty core entity seeds (company, projects, issues, comments, documents, agents, skills, secrets, attachments), and vendor-specific tables populated for releases 1001.0+ (`chat_github_reviews`, `browser_use_runs`, `mcp_oauth_tokens`).
- `myrmidon:migrate` CLI adds `--accept-unknown-source-objects` as a documented alias for `--accept-vendor-only-data`, reporting skipped vendor-only source data in dry-run and execution summaries.
- Verification script `scripts/myrmidon/paperclip-migration-verify.mjs` validates schema compatibility, full dry-run gap reports, entity counts, attachment transfers, secret re-encryption, source DB immutability, and transactional rollback.
- GitHub Actions CI workflow `myrmidon-paperclip-migration.yml` runs a matrix across all five releases with `fail-fast: false`, ensuring independent per-release test reporting.

## changelog-ru

### Эталонные базы данных и матрица CI для всех поддерживаемых релизов вендора (MIGRATE-D3)

- Сгенерированы синтетические эталонные фикстуры и тесты верификации для всех поддерживаемых релизов Paperclip (`v2026.916.0`, `v2026.916.1`, `v2026.1001.0`, `v2026.1005.0`, `v2026.1012.0`) в каталоге `tests/fixtures/paperclip-migration/`.
- Каждый релиз содержит схему DDL, извлечённую из тегов миграций вендора, заполнение базовых сущностей (компания, проекты, задачи, комментарии, документы, агенты, навыки, секреты, вложения) и вендорские таблицы для релизов 1001.0+ (`chat_github_reviews`, `browser_use_runs`, `mcp_oauth_tokens`).
- В CLI `myrmidon:migrate` добавлен флаг `--accept-unknown-source-objects` как алиас для `--accept-vendor-only-data` с отображением пропущенных вендорских данных (`skippedSourceData`) в сводке пробного и боевого прогонов.
- Скрипт верификации `scripts/myrmidon/paperclip-migration-verify.mjs` проверяет совместимость схем, отчёты dry-run, количества сущностей, перенос файлов вложений, перешифрование секретов, неизменность исходной БД и откат транзакции при сбое.
- Workflow CI `myrmidon-paperclip-migration.yml` запускает матрицу по всем пяти релизам с `fail-fast: false`, гарантируя независимую проверку каждого релиза.
