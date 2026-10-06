## divergence-new

<!-- after: 1.6 — экран «Quality» (BASELINE, часть B) -->

### 1.6.2 — BASELINE: сравнение текущего окна с закреплённым снимком (часть C)

| ID | Что изменено | Файлы | Зачем | Тесты | Когда снимать | Ссылка |
|---|---|---|---|---|---|---|
| 1.6.2-BASELINE-C | Новый API endpoint `GET /api/myrmidon/companies/:companyId/baseline/compare` для сравнения метрик текущего окна с закреплённым снимком BASELINE; возвращает метрики, снимок и дельты. Обновлён UI компонент на экране Quality для отображения блока сравнения. | Наши файлы: `server/src/myrmidon/baseline/{routes.ts,service.ts}`, `server/src/myrmidon/baseline/compare.myrmidon.test.ts`, `ui/src/api/baseline.ts`; в вендоре помечены `myrmidon(1.6.2-BASELINE-C)`: `docs/myrmidon/guides/baseline-comparison.md`, `docs/myrmidon/guides/baseline-comparison.ru.md`, `docs/myrmidon/SETTINGS.md` | 1.6.2 BASELINE: видеть, лучше или хуже стало после включения роя: время цикла, доля возвратов, стоимость задачи — по ролям и проектам против закреплённого снимка | `server/src/myrmidon/baseline/compare.myrmidon.test.ts` (тесты для сравнения метрик, дельт, случая отсутствия снимка baseline) | Никогда, наше поведение. Уходит вместе с остальной функциональностью BASELINE | (этот PR) |
