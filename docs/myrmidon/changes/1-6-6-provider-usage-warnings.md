---
divergence-section: Трек 6 — безопасность и модели
---

## changelog-en

### The board tracks provider key and account usage and warns before a package or window runs out (1.6.6 OPE-7189 part E)

- Agent adapters report usage of an LLM key or a Codex account with a versioned
  event, `POST /api/companies/:companyId/provider-usage-reports`. The board keeps
  the latest value per key, window kind and window start; repeated and older
  reports do not overwrite newer ones, and a reset starts a new period.
- A warning fires before the package or window resets, when usage crosses the
  configurable threshold (`PATCH .../provider-usage-warning-threshold`). It shows
  up in the attention feed and as a comment in the issue that owns the secret.
  Raw keys and OAuth values are never stored.
- The secrets registry shows the remaining usage per key (`GET .../provider-usage`).
- Migrations `0401` and `0402` add the usage snapshot, event receipt and warning
  delivery tables.

## changelog-ru

### Доска учитывает расход ключей и учёток провайдеров и предупреждает до исчерпания пакета или окна (1.6.6 OPE-7189, часть E)

- Адаптеры агентов сообщают расход ключа LLM или учётки Codex версионированным
  событием `POST /api/companies/:companyId/provider-usage-reports`. Доска хранит
  последнее значение на ключ, вид окна и начало окна; повторные и более старые
  отчёты новые не перезаписывают, а сброс начинает новый период.
- Предупреждение срабатывает до сброса пакета или окна, когда расход пересекает
  настраиваемый порог (`PATCH .../provider-usage-warning-threshold`). Оно видно в
  ленте внимания и комментарием в задаче-владельце секрета. Сырые ключи и значения
  OAuth не хранятся.
- Реестр секретов показывает остаток расхода по каждому ключу (`GET .../provider-usage`).
- Миграции `0401` и `0402` добавляют таблицы снимков расхода, квитанций событий и
  доставки предупреждений.
