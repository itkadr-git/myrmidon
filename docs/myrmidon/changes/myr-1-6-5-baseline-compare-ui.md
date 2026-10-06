## changelog-en

### Quality screen: comparison with the pinned baseline snapshot (1.6.5-BASELINE-COMPARE-UI)

The Quality screen (`/quality`) gains a "Comparison with the pinned snapshot" block below the two metrics tables. For the same window the page shows, it reads the compare endpoint (merged in 1.6.2, PR #484) and lists, per project and per role: the current window value, the pinned snapshot value and the delta (absolute + percent; the return rate delta in percentage points; green = better, red = worse). A row without a counterpart on either side shows "—" instead of a delta.

- No pinned snapshot is a normal "no baseline yet" state, not an error, and the metrics tables stay intact.
- A failed comparison request is shown as its own error state and does not break the tables above.
- The block follows the page's range preset / custom dates; a guide describes the flow (docs/myrmidon/guides/baseline-comparison.md).

## changelog-ru

### Экран Quality: сравнение с закреплённым снимком (1.6.5-BASELINE-COMPARE-UI)

На экране Quality (`/quality`) под двумя таблицами метрик появился блок «Сравнение с закреплённым снимком». Для того же окна, что выбрано на странице, он читает эндпоинт сравнения (влит в 1.6.2, PR #484) и показывает по каждому проекту и каждой роли: значение текущего окна, значение закреплённого снимка и дельту (абсолютную и в процентах; для доли возвратов — в процентных пунктах; зелёный = лучше, красный = хуже). Строка без пары на одной из сторон показывает «—» вместо дельты.

- Отсутствие закреплённого снимка — штатное состояние «нет базовой линии», а не ошибка; таблицы метрик при этом не ломаются.
- Сбой запроса сравнения показывается отдельным состоянием ошибки и не затрагивает таблицы выше.
- Блок следует пресету/произвольным датам страницы; порядок работы описан в гайде (docs/myrmidon/guides/baseline-comparison.ru.md).

## divergence-new

<!-- after: 1.6 — экран «Quality» (BASELINE, часть B) -->

### 1.6.5 — BASELINE: блок сравнения с закреплённым снимком на экране Quality (часть C, UI)

| ID | Что изменено | Файлы | Зачем | Тесты | Когда снимать | Ссылка |
|---|---|---|---|---|---|---|
| 1.6.5-BASELINE-COMPARE-UI | На экране «Quality» под таблицами метрик — блок «Сравнение с закреплённым снимком»: для того же окна, что у страницы, запрашивается `GET /api/myrmidon/companies/:id/baseline/compare` (API влито в 1.6.2, PR #484) и для каждого проекта и каждой роли показываются рядом «текущее окно / базовая линия / дельта» по пяти метрикам (задач завершено, время цикла (ср), время ревью (ср), доля возвратов, стоимость задачи (ср)); дельта — абсолютная + процент, доля возвратов — в процентных пунктах, цветом: зелёный = стало лучше, красный = хуже. Строки дельт считаются на клиенте из `current.by*` и `baseline.by*`, сопоставленных по ключу (серверный блок `differences` — обобщённый по компании); строка без пары на одной из сторон показывает «—» вместо дельты. Отсутствие закреплённого снимка — отдельное штатное состояние «нет базовой линии», не ошибка; сбой запроса сравнения показывается отдельным состоянием и не ломает таблицы метрик выше. Окно закреплённого снимка выводится под заголовком блока | Наши файлы: `ui/src/pages/BaselineCompareBlock.tsx` (компонент), `ui/src/i18n/myrmidon-locales/{en,ru}.json` (ключи `quality.compare.*`); в вендоре помечены `myrmidon(1.6.5-BASELINE-COMPARE-UI)`: `ui/src/pages/Quality.tsx` + `ui/src/pages/Quality.production.tsx` (импорт и подключение блока), `ui/src/pages/Quality.test.tsx` (мок `compare` + три теста блока) | 1.6.5 BASELINE (пункт 2 задачи OPE-4148): видеть на экране метрик, лучше или хуже стало после включения роя, против закреплённого снимка — без перехода на отдельный экран | `ui/src/pages/Quality.test.tsx` («comparison with the pinned snapshot»: таблицы с дельтами по проектам/ролям и тем же окном запроса, состояние «нет базовой линии» без ошибки и с целыми таблицами метрик, изолированное состояние ошибки сравнения) | Никогда, наше поведение. Уходит вместе с частями A/B/C BASELINE: удалить компонент, строки с меткой в Quality-файлах, ключи `quality.compare.*` и эту строку | (этот PR) |⟪HERMES-CONTEXT-COMPRESSION: 4,903 of 5,103 chars omitted here by Hermes's context compressor. This is NOT part of the original tool call and must never be reproduced in new output — always write full, untruncated content.⟫