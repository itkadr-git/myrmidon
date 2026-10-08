---
divergence-section: Трек 2 — ядро побудок и прогонов
settings-section: Track 2 — wake and run core
---

## changelog-en

### The model input limit is checked before a run is sent (1.6.5-INPUT-LIMIT, OPE-6168)

- The board resolves the agent model's input limit from the model catalog (`litellm_models.maxInputTokens`; override with adapter config `inputLimitTokens` / `inputLimitChars`) and passes it to the adapter.
- When the task's session already holds so many prompts that the next one would not fit, the run starts a fresh session (new `hermes_gateway` session-key generation) and records a `fresh_session` lifecycle event instead of sending into the full session.
- The `hermes_gateway` adapter trims a request that alone exceeds the budget (head and tail of the input kept, the cut named in the middle) instead of sending it to a provider that rejects it.
- Tunables: `MYRMIDON_INPUT_LIMIT_PRECHECK=0` (off), `MYRMIDON_INPUT_LIMIT_CHARS_PER_TOKEN` (3), `MYRMIDON_INPUT_LIMIT_SAFETY` (0.9). See `docs/myrmidon/input-limit-precheck.md`.

## changelog-ru

### Лимит входа модели проверяется до отправки прогона (1.6.5-INPUT-LIMIT, OPE-6168)

- Доска определяет лимит входа модели агента по каталогу моделей (`litellm_models.maxInputTokens`; переопределяется в конфиге адаптера `inputLimitTokens` / `inputLimitChars`) и передаёт его адаптеру.
- Если в сессии задачи уже столько промптов, что следующий не поместится, прогон стартует со свежей сессии (новое поколение ключа сессии `hermes_gateway`) и записывает событие `fresh_session` вместо отправки в переполненную сессию.
- Адаптер `hermes_gateway` обрезает запрос, который сам по себе выше бюджета (голова и хвост входа остаются, середина помечена), вместо отправки провайдеру, который его отклонит.
- Настройки: `MYRMIDON_INPUT_LIMIT_PRECHECK=0` (выкл.), `MYRMIDON_INPUT_LIMIT_CHARS_PER_TOKEN` (3), `MYRMIDON_INPUT_LIMIT_SAFETY` (0,9). См. `docs/myrmidon/input-limit-precheck.ru.md`.

## settings-en

| `MYRMIDON_INPUT_LIMIT_PRECHECK` | 1.6.5-INPUT-LIMIT | on | Checks the model input limit before a run is sent: a task session that would overflow starts a fresh session generation, and an oversized single request is trimmed by the `hermes_gateway` adapter | `0` turns the whole check off; any other value keeps it on |
| `MYRMIDON_INPUT_LIMIT_CHARS_PER_TOKEN` | 1.6.5-INPUT-LIMIT | `3` | Characters-per-token ratio used to estimate prompt size against the input limit (accepted range 1 to 10) | An out-of-range or non-numeric value falls back to the default |
| `MYRMIDON_INPUT_LIMIT_SAFETY` | 1.6.5-INPUT-LIMIT | `0.9` | Share of the model input limit the estimate may fill before a fresh session is started (accepted range above 0 up to 1) | An out-of-range or non-numeric value falls back to the default |

## settings-ru

| `MYRMIDON_INPUT_LIMIT_PRECHECK` | 1.6.5-INPUT-LIMIT | вкл. | Проверяет лимит входа модели до отправки прогона: сессия задачи, которая переполнится, стартует со свежего поколения, а слишком большой одиночный запрос обрезает адаптер `hermes_gateway` | `0` выключает проверку целиком; любое другое значение оставляет её включённой |
| `MYRMIDON_INPUT_LIMIT_CHARS_PER_TOKEN` | 1.6.5-INPUT-LIMIT | `3` | Отношение символов к токенам для оценки размера промпта относительно лимита входа (допустимо от 1 до 10) | Значение вне диапазона или не число заменяется умолчанием |
| `MYRMIDON_INPUT_LIMIT_SAFETY` | 1.6.5-INPUT-LIMIT | `0,9` | Доля лимита входа модели, которую может занять оценка, прежде чем начнётся свежая сессия (больше 0 до 1) | Значение вне диапазона или не число заменяется умолчанием |
