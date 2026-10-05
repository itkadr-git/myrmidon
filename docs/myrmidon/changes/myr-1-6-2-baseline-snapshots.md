---
divergence-section: 1.6 — BASELINE: серверные метрики цикла, ревью, возвратов, блокировок, прогонов и стоимости (часть A)
---

## changelog-en

### Baseline snapshots API: freeze a window, label it, pin it (1.6.2 BASELINE-SNAPSHOTS)

- Three endpoints join the BASELINE metrics route: `POST
  /api/myrmidon/companies/:companyId/baseline/snapshots` computes the metrics
  for the window in the body, stores the whole answer in
  `baseline_metric_snapshots.payload` and returns the stored row;
  `GET .../baseline/snapshots` lists the company snapshots and
  `GET .../baseline/snapshots/:snapshotId` returns one row (404 when the
  company has none).
- `from` and `to` are required; `label` and `pinned` are optional. Pinning a
  snapshot clears `pinned` on the company's previously pinned snapshot, so a
  company keeps a single reference point.
- Creating a snapshot is board-only (`assertBoard` plus the company access
  check); reading is the usual company access check.
- Two additive columns (`label`, `pinned`) with a partial index on the pinned
  snapshots of a company. The vendor tables are only read.
- Guide: `docs/myrmidon/guides/baseline-snapshots-api.md`.

## changelog-ru

### API снимков базовой линии: заморозить окно, пометить и закрепить (1.6.2 BASELINE-SNAPSHOTS)

- К маршруту метрик BASELINE добавлены три эндпоинта: `POST
  /api/myrmidon/companies/:companyId/baseline/snapshots` считает метрики за
  окно из тела запроса, сохраняет ответ целиком в
  `baseline_metric_snapshots.payload` и отдаёт сохранённую строку;
  `GET .../baseline/snapshots` отдаёт список снимков компании, а
  `GET .../baseline/snapshots/:snapshotId` — одну строку (404, если у
  компании такой нет).
- `from` и `to` обязательны, `label` и `pinned` — нет. Закрепление снимка
  снимает `pinned` у прежнего закреплённого снимка компании, поэтому точка
  отсчёта у компании одна.
- Создание снимка доступно только доске (`assertBoard` плюс проверка доступа к
  компании); чтение — обычная проверка доступа к компании.
- Две аддитивные колонки (`label`, `pinned`) и частичный индекс по
  закреплённым снимкам компании. Вендорские таблицы только читаются.
- Руководство: `docs/myrmidon/guides/baseline-snapshots-api.md`.

## divergence

| 1.6.2-BASELINE-SNAPSHOTS | Снимки метрик базовой линии поверх модуля BASELINE части A: `POST /api/myrmidon/companies/:companyId/baseline/snapshots` считает метрики за окно `{from,to}` и кладёт ответ целиком в `baseline_metric_snapshots.payload`, отдавая сохранённую строку (`id`, `companyId`, `windowFrom`, `windowTo`, `generatedAt`, `payload`, `label`, `pinned`); `label` и `pinned` необязательны, закрепление нового снимка снимает `pinned` у прежнего закреплённого снимка компании. Чтение: `GET .../baseline/snapshots` (список компании) и `GET .../baseline/snapshots/:snapshotId` (одна строка, 404 если нет). Запись — только доска (`assertBoard` + доступ к компании), чтение — доступ к компании | Изменённых файлов вендора нет. Новые: `packages/db/src/schema/baseline_metric_snapshots.ts` (колонки `label`, `pinned`, частичный индекс `baseline_metric_snapshots_company_pinned_idx`), `packages/db/src/migrations/0298_add_label_pinned_to_baseline_metric_snapshots.sql`, `docs/myrmidon/guides/baseline-snapshots-api{,.ru}.md`; расширен `server/src/myrmidon/baseline/routes.ts` (маршруты снимков) | Владельцу нужна точка отсчёта: замороженный снимок окна «как было» с меткой и закреплением, чтобы сравнивать с ним последующие измерения. Вендорская таблица снимков — только наша | `server/src/myrmidon/baseline/baseline.snapshot.api.test.ts` (201 и форма строки, необязательные `label`/`pinned`, снятие прежнего закрепления, 400 без окна, 403 для агента, анонима и чужой компании, список, выборка по id и 404) | Никогда, часть функционала 1.6.2 BASELINE. Снятие: удалить маршруты снимков из `routes.ts`, файл миграции, колонки `label`/`pinned` с индексом из схемы, руководство, тест и эту строку | (этот PR) |