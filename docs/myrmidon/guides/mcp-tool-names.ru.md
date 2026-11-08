# Ребренд D: MCP-инструменты доски называются `myrmidon*`, старые имена — алиасы

> English version: [mcp-tool-names.md](mcp-tool-names.md)

Гайд описывает проход 1.7 REBRAND D: MCP-сервер доски
(`packages/mcp-server`) публикует каждый инструмент под именем `myrmidon*`.
Старые имена `paperclip*` продолжают работать как deprecated-алиасы ровно один
релиз, поэтому установленные системы и навыки агентов не ломаются.

## Что изменилось

- **Список инструментов.** `createPaperclipMcpServer` регистрирует 42
  инструмента доски как `myrmidonMe`, `myrmidonListIssues`,
  `myrmidonUpdateIssue`, `myrmidonCheckoutIssue`, `myrmidonAddComment`,
  `myrmidonApiRequest`, … Новое имя — всегда старое с заменой префикса
  `paperclip` на `myrmidon` (остаток и регистр совпадают).
- **Deprecated-алиасы.** Каждое старое имя тоже зарегистрировано, привязано к
  тому же самому объекту схемы и той же самой функции-обработчику (не к
  копии), и в описании несёт пометку
  `(deprecated alias for <новое имя>; will be removed after the 1.7 release)`.
- **Без изменений имён.** Run-scoped инструменты соединений
  `connections_search` и `connection_request` префикса вендора не имеют и
  остаются как есть.

Реализация — один модуль-таблица
`packages/mcp-server/src/tool-aliases.ts`, применяемый при регистрации в
`packages/mcp-server/src/index.ts`. `tools.ts` намеренно не тронут:
`packages/paperclip-runner` парсит из этого файла литералы
`makeTool("paperclip…")` (имена, описания, номера строк) для проверок
capability-инвентаря, поэтому переименование литералов — отдельное
контрактное изменение (см. «Диагностика, привязанная к старым именам»).

## Что НЕ изменилось (поверхность совместимости)

- Переменные окружения сервера (`PAPERCLIP_API_URL`, `PAPERCLIP_API_KEY` и
  остальные) — это зона REBRAND C (алиасы `MYRMIDON_*`).
- Имя пакета `@paperclipai/mcp-server` и бин `paperclip-mcp-server` —
  переименование пакетов вне объёма этой фазы (ждёт решения эпика).
- Имя `serverInfo` (`paperclip`) — метаданные протокола, которые некоторые
  клиенты используют как ключ соединения; отдельное решение.
- Описания инструментов по-прежнему содержат слово «Paperclip» там, где его
  написал вендор: закоммиченные инвентари runner'а пинят эти строки
  буквально; их смена требует перегенерации спеки против eval-корпуса.
- Заголовки HTTP (`X-Paperclip-*`), пути API и всё вне каталога MCP-инструментов.

## Диагностика, привязанная к старым именам

- `packages/paperclip-runner/scripts/check-capability-inventory.mjs` сверяет
  закоммиченные строки `spec/capability/mcp-tool-map.yaml` (имя, описание,
  номер строки в `tools.ts`) с живым парсингом `tools.ts`. Литералы
  `makeTool` со старыми именами обязаны оставаться на своих местах до
  перегенерации спеки.
- `spec/capability/eval-traceability.yaml` и `protocol-coverage.json`
  ссылаются на старые имена как на traceability-id (`mcp:paperclipMe`, …);
  они продолжают указывать на строки-алиасы.

## Снятие алиасов (план: 1.8)

1. Убедиться, что ни одна установленная система, навык агента или внешний
   MCP-гейтвей не вызывают `paperclip*` (аудит доски).
2. Переименовать литералы `makeTool("paperclip…")` в
   `packages/mcp-server/src/tools.ts` на `myrmidon…`, удалить
   `tool-aliases.ts`, его тест и вызов `withMyrmidonToolNames(...)` в
   `index.ts`.
3. В том же PR перегенерировать контракты runner'а (при заданном
   `PAPERCLIP_EVALS_ROOT`: `pnpm --filter @paperclipai/paperclip-runner
   generate:capability-inventory && generate:capability-contract &&
   generate:protocol-coverage`). В карте свёрток
   `legacyMcpFoldTargets` (`scripts/lib/capability-inventory.mjs`) добавить
   строки `myrmidon*`; строки `paperclip*` оставить, только если переходный
   релиз всё ещё их возит.
4. Убрать строку из DIVERGENCE.md и этот гайд.

## Как проверить

- Тесты: `pnpm --filter @paperclipai/mcp-server test` —
  `src/tool-aliases.test.ts` проверяет покрытие таблицей всех 42 старых имён,
  присутствие `myrmidon*` в публикуемом списке, пометку `deprecated` у каждого
  алиаса, совпадение ссылки на обработчик у обоих имён и identical-вызов
  одного API с обоих имён.
- Вручную (stdio): запустить сервер с `PAPERCLIP_API_URL`/`PAPERCLIP_API_KEY`,
  вызвать `tools/list`, убедиться, что `myrmidonMe` и `paperclipMe` оба в
  списке и deprecated-пометка только у второго; вызвать любой из них.
