## changelog-en

### Intake dialog requirement card contract and readiness evaluator (OPE-13007)

Defined the structured `RequirementCard` contract and readiness evaluator for intake dialog workflows:
1. Added `packages/shared/src/myrmidon-requirement-card.ts` exporting `RequirementCard`, `requirementCardSchema`, `evaluateRequirementCard`, and `renderRequirementCardMarkdown`.
2. Mandatory sections (`МЕСТО ПРАВКИ`, `НАМЕРЕНИЕ`, `ГРАНИЦА ОБЪЁМА`, `КРИТЕРИИ ПРИЁМКИ`, `ТЕСТ`) are checked against task card readiness standards without duplicating the canonical section lists.
3. Added unit tests in `packages/shared/src/myrmidon-requirement-card.test.ts` verifying all readiness rules, missing sections detection, checkable claim requirements, and markdown rendering.

## changelog-ru

### Контракт карточки требования и проверка готовности для диалога приёма (OPE-13007)

Определен структурированный контракт `RequirementCard` и валидатор готовности для диалога планировщика:
1. Создан модуль `packages/shared/src/myrmidon-requirement-card.ts`, экспортирующий `RequirementCard`, `requirementCardSchema`, `evaluateRequirementCard` и `renderRequirementCardMarkdown`.
2. Обязательные разделы (`МЕСТО ПРАВКИ`, `НАМЕРЕНИЕ`, `ГРАНИЦА ОБЪЁМА`, `КРИТЕРИИ ПРИЁМКИ`, `ТЕСТ`) валидируются по единым правилам готовности карточки задачи без дублирования списков обязательных разделов.
3. Добавлены модульные тесты в `packages/shared/src/myrmidon-requirement-card.test.ts`, проверяющие все правила готовности, выявление отсутствующих разделов, наличие проверяемого утверждения и рендеринг markdown.
