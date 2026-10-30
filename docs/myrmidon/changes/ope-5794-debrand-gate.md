# OPE-5794: 1.6.6 DEBRAND Gate & Brand Audit Integration

## Описание изменения

В рамках закрытия эпика DEBRAND для версии 1.6.6 (OPE-5794) все промежуточные этапы дебрандинга (UI, серверные логи, localStorage, CLI, тексты навыков, package scope, аудит документации и манифестов) были реализованы и влиты в кодовую базу.

Данное изменение завершает кодовую часть эпика:
1. Добавляет команду `pnpm run check:brand` (`check:brand` в `package.json`), запускающую:
   - `node scripts/myrmidon/docs-branding-guard.mjs`
   - `node scripts/myrmidon/brand-release-audit.mjs --gate`
2. Интегрирует проверку `Brand release audit (DEBRAND gate)` в рабочий процесс GitHub Actions (`.github/workflows/myrmidon-ci.yml`, job `checks`), гарантируя соблюдение критериев отсутствия упоминаний устаревшего бренда во всех последующих PR и релизных сборках.

## Таблица расхождений

| Путь | До изменения | Что сделано в Myrmidon | Почему |
| --- | --- | --- | --- |
| `package.json` | Отсутствовал `check:brand` | Добавлен вызов `docs-branding-guard.mjs` и `brand-release-audit.mjs --gate` | Локальная и скриптовая проверка бренда перед коммитом |
| `.github/workflows/myrmidon-ci.yml` | `brand-release-audit --gate` не вызывался в CI | Добавлен шаг `Brand release audit (DEBRAND gate)` в джобу `checks` | Гарантия недопущения регрессий брендинга в main |

## Приёмка и проверка

1. `npm run check:brand` (или `node scripts/myrmidon/docs-branding-guard.mjs && node scripts/myrmidon/brand-release-audit.mjs --gate`) проходит с кодом 0 (clean, 0 non-allowlisted mentions).
2. Шаг `Brand release audit (DEBRAND gate)` выполняется и проходит в CI.
