## changelog-en

### BOT-RUNTIME-TUNING, part C: per-model effort validation and safe default instead of medium (1.6.5-BOT-RUNTIME-TUNING)

- The agent card's "Thinking effort" field now offers only the values the
  selected model accepts (GLM models via DashScope: low/high/max), and saving
  the card rejects (422) a value the model refuses.
- An empty effort on the card no longer reaches Hermes as its global default
  "medium": the profile compiler (bot containers) and the single-run config
  overlay (hermes adapter) write the model's own safe default instead
  (GLM → high), so DashScope no longer rejects the effort and the LLM gateway
  no longer falls back to another model on every call.
- The effort registry (`effortsForModel` / `effortForModel`) is the single
  source; a future model-provider registry entry overrides the static table.

## changelog-ru

### BOT-RUNTIME-TUNING, часть C: валидация effort по модели и безопасный дефолт вместо medium (1.6.5-BOT-RUNTIME-TUNING)

- Поле «Thinking effort» на карточке агента предлагает только значения,
  которые принимает выбранная модель (GLM через DashScope: low/high/max), а
  сохранение карточки отклоняет (422) значение, которое модель не принимает.
- Пустой effort больше не доходит до Hermes как его глобальный дефолт
  «medium»: компилятор профиля (бот-контейнеры) и наложение конфига одного
  прогона (адаптер hermes) записывают вместо него безопасный дефолт самой
  модели (GLM → high), поэтому DashScope не отклоняет effort и LLM-шлюз
  больше не откатывается на другую модель при каждом вызове.
- Реестр effort (`effortsForModel` / `effortForModel`) — единый источник;
  будущая запись реестра провайдеров моделей переопределяет статическую
  таблицу.
