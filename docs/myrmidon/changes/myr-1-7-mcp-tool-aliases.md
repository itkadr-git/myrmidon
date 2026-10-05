---
divergence-section: Брендинг
---

## changelog-en

### Board MCP tool names renamed to `myrmidon*` with one-release aliases (1.7 REBRAND D)

- The board MCP server (`packages/mcp-server`) publishes every tool under a
  `myrmidon*` name (`myrmidonMe`, `myrmidonListIssues`, `myrmidonUpdateIssue`,
  …). Each old `paperclip*` name stays registered as a deprecated alias bound
  to the same handler for exactly one release, so existing agent skills and
  installed systems keep working; the alias is marked in the tool description.
  The `connections_search`/`connection_request` tools have no vendor prefix
  and are unchanged. Details and the 1.8 removal plan:
  [guides/mcp-tool-names.md](guides/mcp-tool-names.md).
- Guard test: `packages/mcp-server/src/tool-aliases.test.ts` (both names call
  one handler; every old name mapped and marked deprecated; catalog-drift
  guard).

## changelog-ru

### MCP-инструменты доски переименованы в `myrmidon*` с алиасами на один релиз (1.7 REBRAND D)

- MCP-сервер доски (`packages/mcp-server`) публикует каждый инструмент под
  именем `myrmidon*` (`myrmidonMe`, `myrmidonListIssues`, `myrmidonUpdateIssue`,
  …). Каждое старое имя `paperclip*` остаётся зарегистрированным как
  deprecated-алиас того же обработчика ровно один релиз — установленные
  системы и навыки агентов продолжают работать; пометка — в описании
  инструмента. `connections_search`/`connection_request` префикса вендора не
  имеют и не изменились. Подробности и план снятия в 1.8:
  [guides/mcp-tool-names.ru.md](guides/mcp-tool-names.ru.md).
- Тест-сторож: `packages/mcp-server/src/tool-aliases.test.ts` (оба имени
  вызывают один обработчик; каждое старое имя замапплено и помечено
  deprecated; сторож дрейфа каталога).

## divergence

| 1.7-RD | MCP-сервер доски публикует все 42 инструмента доски под именами `myrmidon*` (префикс `paperclip` заменён на `myrmidon`, остаток и регистр совпадают); старые имена `paperclip*` остаются зарегистрированными алиасами того же объекта схемы и той же функции-обработчика ровно один релиз, с пометкой `deprecated alias for …; will be removed after the 1.7 release` в описании. `connections_search`/`connection_request` без префикса — не тронуты. Слой имён — новый модуль `packages/mcp-server/src/tool-aliases.ts`, применяемый в `createPaperclipMcpServer` (`index.ts`); `tools.ts` (вендорский) сохранён без изменений буквально: `packages/paperclip-runner` парсит из него `makeTool("paperclip…")` (имя, описание, номер строки) для проверок capability-инвентаря (`check-capability-inventory`), поэтому переименование литералов — шаг снятия алиасов вместе с перегенерацией спеки (пошагово: docs/myrmidon/guides/mcp-tool-names.md). Обновлены: список инструментов в README пакета и навык компании (`skills/paperclip/references/issue-workspaces.md`), текстовые ссылки — на новые имена. Попутно: устаревшее ожидание вендорского теста `tools.test.ts` (create issue без `allowDuplicate`) исправлено под вендорский dedup-guard из main — иначе suite пакета красный на любом PR, его затрагивающем | `packages/mcp-server/src/index.ts` (обёртка списка инструментов вызовом `withMyrmidonToolNames`, маркеров нет — одна точка сборки), `packages/mcp-server/src/tools.test.ts` (ожидание тела create: `allowDuplicate: false`); `+ packages/mcp-server/src/tool-aliases.ts`, `+ packages/mcp-server/src/tool-aliases.test.ts` (наши файлы) | REBRAND 1.7: название вендора остаётся только в LICENSE/NOTICE и строке «based on … (MIT)»; имена инструментов — публичный идентификатор для навыков агентов, поэтому переименование с алиасом на один релиз (совместимость установленной системы) | `packages/mcp-server/src/tool-aliases.test.ts` (полное покрытие таблицы, присутствие `myrmidon*` в публикуемом списке, `deprecated`-пометка каждого алиаса, совпадение ссылок `execute`/`schema` у обоих имён, identical HTTP-вызов с обоих имён, сторож дрейфа каталога, отсутствие дублей) | После 1.8: снять алиасы, переименовать литералы `makeTool` в `tools.ts`, удалить `tool-aliases.ts` + тест и вызов в `index.ts`, перегенерировать контракты runner'а (см. гайд), убрать эту строку | (этот PR) |
