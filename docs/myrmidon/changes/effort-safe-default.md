## changelog-en

### BOT-TUNING-C — per-model effort validation and safe default

- Document per-model validation of the agent-card Thinking effort field and the model-safe default used when the field is empty.
- GLM models via DashScope accept `low`, `high`, and `max`; empty effort resolves to `high` instead of Hermes' incompatible global `medium`.

## changelog-ru

### BOT-TUNING-C — проверка effort по модели и безопасный дефолт

- Задокументирована проверка поля Thinking effort в карточке агента по допустимым значениям модели и безопасный дефолт модели для пустого поля.
- GLM-модели через DashScope принимают `low`, `high` и `max`; пустой effort разрешается в `high`, а не в несовместимый глобальный `medium` Hermes.

## settings-en

## settings-en-append

<!-- section: Settings in the agent record (not environment variables) -->
| `adapterConfig.effort` | BOT-TUNING-C | empty (compiles to the model's safe default) | Agent-card Thinking effort. Only values accepted by the selected model can be saved; for GLM via DashScope these are `low`/`high`/`max`, and empty resolves to `high` as `agent.reasoning_effort` in the bot config instead of Hermes' incompatible global `medium`. Applies to `hermes_local`; other adapters keep their own level sets. Details: [bot container card guide](guides/bot-container-card.md) | Clear the field to return to the model default; unsupported values are rejected with `invalid_effort` |

## settings-ru-append

<!-- section: Настройки в записи агента (не переменные окружения) -->
| `adapterConfig.effort` | BOT-TUNING-C | пусто (компилируется в безопасный дефолт модели) | Поле Thinking effort карточки агента. Сохраняются только значения выбранной модели; для GLM через DashScope это `low`/`high`/`max`, пустое значение разрешается в `high` как `agent.reasoning_effort` в конфиге бота вместо несовместимого глобального `medium` Hermes. Для `hermes_local`; прочие адаптеры используют свои наборы уровней. Подробнее: [руководство по карточке контейнера](guides/bot-container-card.ru.md) | Очистите поле, чтобы вернуть дефолт модели; неподдерживаемые значения отклоняются с `invalid_effort` |
