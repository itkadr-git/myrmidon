## changelog-en

### Knowledge reader and regulations in UI 2.0 (KNOWLEDGE-2.0 K-4)

- Added the feature-gated **Knowledge** screen: company-scoped tree, full-text
  search, clickable `[[…]]` links, source and backlink panels, revision diff,
  and policy-gated rollback.
- Added the **Work** navigation group and the Autonomy **Regulations** view,
  grouped by caste with revision state and the required approver.
- Added the knowledge REST facade required by the reader, with company access,
  tool-access, injection, autonomy, and domain gates.
- Added Russian UI 2.0 catalog coverage and a guard that rejects untranslated
  English copy in the new Russian namespaces.

## changelog-ru

### Читалка знаний и регламенты в UI 2.0 (KNOWLEDGE-2.0 K-4)

- Добавлен экран **«Знания»** за флагом: дерево в рамках компании,
  полнотекстовый поиск, кликабельные ссылки `[[…]]`, панели источников и
  обратных ссылок, diff ревизий и откат с проверкой политики.
- Добавлены группа навигации **«Работа»** и представление **«Регламенты»** в
  автономии: группировка по касте, статус ревизии и необходимый утверждающий.
- Добавлен REST-фасад знаний, нужный читалке: границы компании, доступ к
  инструменту, защита от инъекций, автономия и доменные проверки.
- Добавлено покрытие каталогов UI 2.0 на русском и сторож против
  непереведённых английских строк в новых русских пространствах имён.

## divergence-new

### 1.6.6 — KNOWLEDGE-2.0 K-4: экран знаний и регламенты

| ID | Что изменено | Файлы | Зачем | Тесты | Когда снимать | Ссылка |
|---|---|---|---|---|---|---|
| 1.6.6-KNOWLEDGE-K4 | Экран UI 2.0 «Знания»: дерево, поиск, ссылки `[[…]]`, источники/обратные ссылки, история ревизий с diff и откатом; экран регламентов автономии по кастам и approver kind. Добавлен REST-фасад модуля знаний с company/tool/injection/autonomy/domain gates. | Новые: `server/src/myrmidon/knowledge/routes.ts`, `packages/shared/src/myrmidon-knowledge-tools.ts`, `ui/src/ui2/screens/knowledge/**`, `docs/myrmidon/guides/knowledge-screen*.md`; вендорные точки с метками: `server/src/app.ts`, `server/src/routes/openapi.ts`, `packages/shared/src/{index.ts,myrmidon-autonomy.ts}`, `ui/src/{i18n/locales/{en,ru}.json,ui2/{routes.tsx,navModel.ts,i18n/locales.ts}}` | Человек читает, ищет и проверяет знания без плагина; регламенты видны и утверждаются по явному носителю полномочия | `knowledgeModel.myrmidon.test.ts` (дерево <300 мс, ссылки, источники, diff, A/O); `regulationsModel.myrmidon.test.ts` (касты и действия по approver kind); `no-english-in-ru.knowledge.myrmidon.test.ts`; `routes.myrmidon.test.ts` (гейты REST) | Никогда, наше поведение; временная UI-2.0 оболочка остаётся за `enableMyrmidonUi2` до полного паритета | (this PR) |
