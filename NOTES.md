# NOTES — OPE-13086 PF-STARTER-PACK v1

## Задача
1. Если у задачи есть документ с ключом `starter-pack` — его текст идёт в побудку исполнителя (`issue_assigned`, продолжения, повторы, `execution_changes_requested`) отдельным блоком **перед** текстом задачи, с заголовком `Starter pack (start here; do not re-explore the project)`. Длина блока — не больше 8 000 знаков, лишнее обрезается с пометкой.
2. Для ревьюера блок не добавляется (изоляция ревьюера не меняется).
3. Нет документа — побудка прежняя, байт в байт.

## Исследованные места в коде
1. `packages/shared/src/constants.ts`:
   - Добавить константу:
     ```ts
     export const ISSUE_STARTER_PACK_DOCUMENT_KEY = "starter-pack" as const;
     export type IssueStarterPackDocumentKey = typeof ISSUE_STARTER_PACK_DOCUMENT_KEY;
     ```
   - Экспорт в `packages/shared/src/index.ts`.

2. Чтение документа:
   - В `server/src/services/issue-continuation-summary.ts` или новом файле `server/src/services/issue-starter-pack.ts`:
     ```ts
     export async function getIssueStarterPackDocument(db: Db, issueId: string) { ... }
     ```
     Читает из `issueDocuments` + `documents` по `key = "starter-pack"`.
     Ограничение длины 8 000 знаков (truncateText с пометкой `\n[starter pack truncated]` или аналог).

3. `server/src/services/heartbeat.ts`:
   - Около строки ~25828:
     ```ts
     const isolatedReviewerRun = isDeveloperRole(agent) && parseObject(context.executionStage).wakeRole === "reviewer";
     ```
     Рядом с чтением continuationSummary:
     ```ts
     const starterPack = issueRef && !isConversation(issueContext) && !isolatedReviewerRun
       ? await getIssueStarterPackDocument(db, issueRef.id)
       : null;
     ```
   - Добавление в `buildPaperclipWakePayload`:
     Если `isolateReviewerWake` или роль ревьюера — `starterPack: null`.
     Для исполнителя: передаётся `starterPack: { key, title, body, bodyTruncated }` в payload.

4. Рендер побудки:
   - `packages/adapter-utils/src/server-utils.ts`:
     В типах wake payload: `starterPack?: PaperclipWakeStarterPack | null`.
     В `renderPaperclipWakePromptBody`:
     Около строки ~3154 (перед продолжением/описанием задачи):
     ВНИМАНИЕ: постановка задачи говорит:
     «отдельным блоком **перед** текстом задачи, с заголовком `Starter pack (start here; do not re-explore the project)`. Длина блока — не больше 8 000 знаков, лишнее обрезается с пометкой.»
     И в описании задачи:
     «Рендер текста побудки для адаптера hermes — `server/src/services/server-utils.ts` около 3174 (тот же путь использует PR #3171, OPE-13077 — не конфликтовать, блок пакета ставить до блока «прервано выкатом»).»
     Строка 3174 в `server-utils.ts` — это перед `Run liveness continuation:` (строка 3174)!
     Именно там и `Issue continuation summary:` (строки 3154-3172).
     Блок `Starter pack` ставится прямо перед блоком continuation summary или перед liveness continuation:
     ```ts
     if (normalized.starterPack) {
       lines.push(
         "",
         "Starter pack (start here; do not re-explore the project):",
         summaryBody, // с пометкой обрезки если > 8000
       );
     }
     ```

5. Тесты:
   - `packages/adapter-utils/src/server-utils.test.ts`:
     Тест на `renderPaperclipWakePrompt` с `starterPack`:
     - Задача с `starterPack` -> блок есть с заголовком `Starter pack (start here; do not re-explore the project)`.
     - Задача без -> текст байт-в-байт.
     - Документ > 8000 знаков -> обрезка с пометкой.
   - `server/src/__tests__/heartbeat-agent-session-message.test.ts` (или отдельный тест):
     - Ревьюер -> блока нет (`isolateReviewerWake`).
     - Исполнитель -> блок передаётся.

6. Change fragment:
   - `docs/myrmidon/changes/1-6-9-starter-pack-delivery-en.md`
   - `docs/myrmidon/changes/1-6-9-starter-pack-delivery-ru.md`
