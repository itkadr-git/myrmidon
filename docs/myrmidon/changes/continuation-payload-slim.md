---
divergence-section: Трек 3 — шлюз инструментов и адаптер Hermes
---

## changelog-en

### A continuation wake carries a summary, not the task history three times (WAKE-HISTORY)

- The structured wake payload JSON that gateway adapters put into the prompt no longer repeats the
  execution continuation: `executionContinuation.messages`, `resumeDelta.messages`, the completed
  work and the other evidence stay in the rendered "Current request and continuation context"
  section only. The JSON keeps the envelope shape and cursors and names what it left out in
  `omittedFromJson`. The JSON is capped at 12000 characters; over the cap the largest cappable keys
  are emptied and listed in `jsonTruncation`.
- New card setting `wakeHistory` for the `hermes_gateway` adapter (`auto` | `summary` | `recent` |
  `full`). `auto` (default) sends the summary only when `sessionKeyStrategy` is `run` or `none`:
  the previous run, its final status, the completed work (2000 characters at most), the open
  interactions and no earlier messages. Every other card gets the newest 8 messages once, each cut
  to 1000 characters (8000 in total); the comments the run was woken for and the latest human
  request stay.
- The continuation envelope gets `previousRun` (`runId`, `status`).

## changelog-ru

### Побудка-продолжение несёт сводку, а не историю задачи трижды (WAKE-HISTORY)

- Структурированный JSON побудки, который шлюзовые адаптеры кладут в промпт, больше не повторяет
  контекст продолжения: `executionContinuation.messages`, `resumeDelta.messages`, выполненная
  работа и остальные свидетельства остаются только в отрисованном разделе «Current request and
  continuation context». JSON сохраняет форму и курсоры конверта, а пропущенное называет в
  `omittedFromJson`. JSON ограничен 12000 символами; сверх лимита самые крупные допустимые ключи
  опустошаются и перечисляются в `jsonTruncation`.
- Новая настройка карточки `wakeHistory` адаптера `hermes_gateway` (`auto` | `summary` | `recent` |
  `full`). `auto` (по умолчанию) шлёт только сводку, когда `sessionKeyStrategy` равна `run` или
  `none`: прошлый прогон, его итоговый статус, выполненная работа (не более 2000 символов), открытые
  взаимодействия и никаких прежних сообщений. Остальные карточки получают последние 8 сообщений
  один раз, каждое до 1000 символов (всего 8000); комментарии, ради которых разбудили, и последняя
  просьба человека остаются.
- В конверт продолжения добавлено `previousRun` (`runId`, `status`).

## divergence

| ID | Что меняем | Файлы вендора | Причина | Тест-сторож | Как снимать | PR |
|---|---|---|---|---|---|---|
| WAKE-HISTORY | История задачи доходит до модели один раз. JSON-копия payload побудки (`stringifyPaperclipWakePayload`) не повторяет конверт продолжения (сообщения, `resumeDelta`, свидетельства) и ограничена 12000 символами с перечнем опустошённых ключей; отрисовка (`renderPaperclipWakePrompt`) принимает режим `wakeHistory` (`summary`, `recent`, `full`), а адаптер `hermes_gateway` выбирает его по карточке (`wakeHistory`, иначе по `sessionKeyStrategy`: `run`/`none` — сводка, остальные — последние 8 сообщений). Конверт получает необязательное поле `previousRun` | `packages/adapter-utils/src/server-utils.ts` (импорт, `stringifyPaperclipWakePayload`, опция `wakeHistory` отрисовки, блок продолжения, потолок сводки; метки `myrmidon(WAKE-HISTORY)`) + `packages/adapters/hermes/src/gateway/server/execute.ts` (вызов отрисовки) + `packages/adapters/hermes/src/gateway/server/config-schema.ts` и `packages/adapters/hermes/src/gateway/index.ts` (поле карточки и описание) + `server/src/services/execution-continuation.ts` (`previousRun`) + `packages/shared/src/types/execution-continuation.ts` (тип); наш модуль `packages/adapter-utils/src/wake-history.ts` | Побудка продолжения у шлюзового агента весила 102 тыс. символов: одни и те же 30 сообщений задачи шли три раза (отрисованный раздел, `executionContinuation.messages`, `resumeDelta.messages`), а полезная сводка занимала 2 тыс. Агенты разработки стартуют свежую сессию на каждый прогон и не должны грузить прошлые прогоны | `packages/adapter-utils/src/wake-history.myrmidon.test.ts` (ни одно сообщение не повторяется между промптом и JSON; сводка без сообщений; не более 8 сообщений по 1000 символов, 8000 всего; потолок JSON 12000), `packages/adapters/hermes/src/gateway/server/wake-history.myrmidon.test.ts` (режим по стратегии сессии и по карточке на запросе шлюза), `server/src/services/execution-continuation.test.ts` (`previousRun`) | Никогда, наше поведение. Снятие: удалить блоки `myrmidon(WAKE-HISTORY)`, модуль `wake-history.ts`, поле карточки и тесты | (этот PR) |
