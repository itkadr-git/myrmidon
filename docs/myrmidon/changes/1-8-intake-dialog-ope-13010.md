# 1.8 INTAKE-DIALOG: диалог уточнения и утверждение заказчиком (OPE-13010)

## changelog-en
- Added server intake-dialog service (`server/src/myrmidon/intake-dialog/`) to evaluate requirement cards, request clarifications on incomplete requirements, and publish idempotent confirmation requests tied to requirement-card document revisions.
- Added `@myrmidon/shared` requirement card types, evaluation logic, and markdown rendering.
- Added comprehensive integration test suite verifying that incomplete cards do not create tasks or interactions, complete cards generate exactly one confirmation tied to the document revision, updates expire stale confirmation requests, and repeated calls remain idempotent.

## changelog-ru
- Добавлен серверный сервис диалога уточнения (`server/src/myrmidon/intake-dialog/`), проверяющий полноту карточки требований: неполные требования возвращают вопросы по недостающим разделам без создания задач и интеракций; полная карточка сохраняется документом `requirement-card` с созданием `request_confirmation`, привязанного к ревизии документа.
- Добавлены типы карточки требований, функция оценки полноты `evaluateRequirementCard` и рендеринг в markdown в `@myrmidon/shared`.
- Добавлен набор интеграционных тестов (`service.myrmidon.test.ts`), проверяющий: возврат `needs_clarification` на неполный запрос, ровно один `request_confirmation` на полную карточку с корректным `target.type=issue_document` и `revisionId`, инвалидацию старых подтверждений (`stale_target`/`expired`) при новой ревизии и идемпотентность повторного вызова.
