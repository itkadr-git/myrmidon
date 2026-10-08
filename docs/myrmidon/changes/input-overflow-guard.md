---
divergence-section: Трек 2 — ядро побудок и прогонов
settings-section: Track 2 — wake and run core
---

## changelog-en

### Input-overflow guard and fresh session on automatic retries (1.6.5-INPUT-OVERFLOW, OPE-6168)

- Automatic `transient_failure_retry` runs start a fresh task session instead of resuming the failed attempt's session (upstream #15487); the codex same-session first step is kept.
- New error family `input_overflow` for provider input-length rejections (DashScope, OpenAI, Anthropic, Gemini, generic wording table); `hermes_gateway` sets it and the server also detects it by text.
- After an overflow failure the next attempt uses a fresh session (task session dropped, `hermes_gateway` session key gets a generation suffix); after N consecutive identical failures on one issue (`MYRMIDON_INPUT_OVERFLOW_MAX_FAILURES`, default 3) automatic retries stop and the issue is escalated with the facts. See `docs/myrmidon/input-overflow-guard.md`.

## changelog-ru

### Предохранитель переполнения входа и свежая сессия на автоповторах (1.6.5-INPUT-OVERFLOW, OPE-6168)

- Автоматические прогоны `transient_failure_retry` начинают свежую сессию задачи, а не продолжают сессию упавшей попытки (апстрим #15487); первый шаг codex `same_session` сохранён.
- Новое семейство ошибок `input_overflow` для отказов провайдера по длине входа (DashScope, OpenAI, Anthropic, Gemini, таблица общих формулировок); его ставит `hermes_gateway`, сервер распознаёт и по тексту.
- После такого отказа следующая попытка идёт со свежей сессией (сессия задачи сброшена, ключ сессии `hermes_gateway` получает суффикс поколения); после N подряд одинаковых отказов по задаче (`MYRMIDON_INPUT_OVERFLOW_MAX_FAILURES`, по умолчанию 3) автоповторы останавливаются, задача эскалируется с фактами. См. `docs/myrmidon/input-overflow-guard.ru.md`.

## divergence

| OPE-6168 | Автоповтор `transient_failure_retry` сбрасывает сессию задачи (#15487); семейство ошибок `input_overflow` (таблица формулировок в adapter-utils), сброс сессии и поколение сессии `hermes_gateway`, остановка после N подряд отказов с эскалацией задачи | `server/src/services/heartbeat.ts` (`shouldResetTaskSessionForWake`, `handleInputOverflowFailure`, `sessionGeneration` в конфиге адаптера), `server/src/myrmidon/input-overflow-guard.ts`, `packages/adapter-utils/src/{input-overflow,types}.ts`, `packages/adapters/hermes/src/gateway/server/execute.ts` | Повторы упавшего хода наращивали сессию до 9,6 МБ, отказ «Range of input length» считался повторяемым и крутился с частотой планировщика без карточки внимания | `input-overflow.test.ts`, `input-overflow-guard.myrmidon.test.ts`, `heartbeat-workspace-session.test.ts`, hermes `execute.test.ts` | Убрать ветку `transient_failure_retry` в `shouldResetTaskSessionForWake`, вызов `handleInputOverflowFailure` и блок `sessionGeneration` | OPE-6168 |

## settings-en

| `MYRMIDON_INPUT_OVERFLOW_MAX_FAILURES` | OPE-6168 | 3 | Number of consecutive input-overflow failures of one agent on one issue after which automatic retries stop and the issue is escalated with an attention comment. Integer ≥ 1 | Unset for the default; invalid or `0` falls back to 3 |

## settings-ru

| `MYRMIDON_INPUT_OVERFLOW_MAX_FAILURES` | OPE-6168 | 3 | Число подряд отказов переполнения входа одного агента по одной задаче, после которого автоповторы останавливаются и задача эскалируется с комментарием внимания. Целое ≥ 1 | Не задавать — значение по умолчанию; неверное или `0` даёт 3 |
