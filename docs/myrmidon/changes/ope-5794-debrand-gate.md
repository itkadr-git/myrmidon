## changelog-en

### Enforce brand release audit gate in CI (OPE-5794)

- Integrated `Brand release audit (DEBRAND gate)` step in `.github/workflows/myrmidon-ci.yml` checks job to enforce `brand-release-audit.mjs --gate` and `docs-branding-guard.mjs`.
- Added `check:brand` script in `package.json`.

## changelog-ru

### Автоматический гейт аудита бренда в CI (OPE-5794)

- Интегрирован шаг `Brand release audit (DEBRAND gate)` в `.github/workflows/myrmidon-ci.yml` (джоба checks) для обязательной проверки `brand-release-audit.mjs --gate` и `docs-branding-guard.mjs`.
- Добавлен скрипт `check:brand` в `package.json`.
