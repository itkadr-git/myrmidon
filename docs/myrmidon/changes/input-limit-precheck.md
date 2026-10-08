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
