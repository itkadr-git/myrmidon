---
divergence-section: Трек 4 — чаты и навыки
---

## changelog-en

### Telegram `/model` and `/think` work for gateway agents (1.6.5-F06-A)

- The gateway adapter (`hermes_gateway`) is allowed for both `/model` and
  `/think`. It compiles the same hermes profile and hands `model`/`effort` to
  the run, so a chat override reaches it the same way it reaches `hermes_local`
  — the note that kept it out ("until the gateway passes a model") was stale.
- For a gateway agent `/model` lists the model catalog of the LLM gateway:
  this agent key's own allowlist when the gateway answers it, the whole catalog
  otherwise, and the reply says which of the two it is. The list is grouped by
  provider family (`dashscope-*`, `zai-*`, `nous-*`), the card's own model and
  its fallbacks stay on top, and the 30-model cap is unchanged.
- Writing a gateway agent's `/model` or `/think` now applies its profile
  without a restart: the reply says the change takes effect from the next
  reply. If the apply fails, the card is restored to its previous value and the
  reply names the reason; with the bot-containers feature off nothing is
  treated as broken — the value stays and the reply says the new profile is not
  applied yet.
- `/think` checks the chosen level against the model's own effort list
  (effort-policy): a level the model does not accept (e.g. `medium` for a GLM
  model) is not written, and the answer names the allowed levels.
- A refusal for an unsupported adapter now names the adapter type and the
  reason, in the language of the chat's user.

## changelog-ru

### Telegram `/model` и `/think` работают для шлюзовых агентов (1.6.5-F06-A)

- Шлюзовый адаптер (`hermes_gateway`) разрешён и для `/model`, и для `/think`.
  Он компилирует тот же hermes-профиль и передаёт `model`/`effort` в прогон,
  поэтому чат-переопределение доходит до него так же, как до `hermes_local`;
  пометка «пока шлюз не передаёт модель», державшая его в стороне, устарела.
- Для шлюзового агента `/model` показывает каталог моделей LLM-шлюза: список,
  разрешённый ключу этого агента, когда шлюз его отдаёт, иначе — весь каталог;
  ответ говорит, какой из двух случаев. Список сгруппирован по семейству
  провайдера (`dashscope-*`, `zai-*`, `nous-*`), модель карточки и её
  резервные остаются сверху, предел в 30 моделей не меняется.
- Запись `/model` или `/think` для шлюзового агента теперь применяет его
  профиль без перезапуска: ответ говорит, что изменение вступит в силу со
  следующего ответа. Если применить не удалось, карточка возвращается к
  прежнему значению, а ответ называет причину; при выключенных bot-containers
  ошибки нет — значение остаётся, и ответ говорит, что новый профиль пока не
  применён.
- `/think` сверяет выбранный уровень со списком усилий самой модели
  (effort-policy): уровень, который модель не принимает (например `medium`
  для GLM), не записывается, а ответ называет допустимые уровни.
- Отказ для неподдерживаемого адаптера теперь называет тип адаптера и причину
  на языке пользователя чата.

## divergence

| 1.6.5-F06-A | Telegram `/model` и `/think` для шлюзовых агентов (`hermes_gateway`): каталог моделей из LLM-шлюза (список ключа агента, иначе весь каталог — с пометкой в ответе), группировка по семейству провайдера (`dashscope-*`/`zai-*`/`nous-*`), применение профиля без перезапуска (`applyBotContainerNow` с `force`, откат значения при ошибке, `not_applicable` при выключенных bot-containers — не ошибка), проверка усилия `/think` по `effortsForModel`, тексты отказа с типом адаптера и причиной в локалях | Наши файлы `server/src/myrmidon/agent-chat-bridge/commands/{models,overrides,index}.ts`, `server/src/myrmidon/agent-chat-bridge/locales/{en,ru}.ts`, `server/src/myrmidon/agent-chat-bridge/gateway-model-catalog.ts` (новый), `server/src/myrmidon/litellm-costs/litellm-costs.ts` (чтение `/v1/models` по ключу агента); вендорских файлов не трогаем | 80 из 84 боевых агентов — шлюзовые: команды смены модели и усилия из Telegram у них не работали; механизм применения без перезапуска уже существует для ротации ключей, теперь им пользуется и команда | `server/src/myrmidon/agent-chat-bridge/commands/commands.myrmidon.test.ts` | Никогда, наше поведение. Если у вендора появится собственный выбор модели из чата — сверить и удалить куски `myrmidon(F06-A)` | (этот PR) |