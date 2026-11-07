## changelog-en

### hermes_local switch-off flag (hermes-local-off)

- New operator environment variable `MYRMIDON_DISABLE_HERMES_LOCAL`. When it is
  exactly `1`, the `hermes_local` adapter is treated as disabled: it is left out
  of the enabled adapter list offered for new agents, `GET /api/adapters/:type`
  reports it as disabled, and creating or switching an agent to `hermes_local`
  is rejected with "Adapter is not available on this instance".
- Off by default: when the variable is unset or has any other value, nothing
  changes. Existing agents and the registered adapter are not modified.

## changelog-ru

### Флаг вывода hermes_local (hermes-local-off)

- Новая переменная окружения оператора `MYRMIDON_DISABLE_HERMES_LOCAL`. При
  значении ровно `1` адаптер `hermes_local` считается выключенным: он пропадает
  из списка включённых адаптеров для новых агентов, `GET /api/adapters/:type`
  показывает его выключенным, а создание агента или перевод на `hermes_local`
  отклоняется с ошибкой «Adapter is not available on this instance».
- По умолчанию выключено: если переменная не задана или имеет другое значение,
  ничего не меняется. Существующие агенты и сам зарегистрированный адаптер не
  затрагиваются.

## settings-en-new

<!-- after: 1.2 — IDLE-STOP (idle bot containers) -->
### 1.2 — hermes-local-off (retire the hermes_local adapter)

| Variable | Default | Description |
| --- | --- | --- |
| `MYRMIDON_DISABLE_HERMES_LOCAL` | unset | Set to `1` to disable the `hermes_local` adapter for new selection and report it as disabled. Any other value or unset: no change. |

## settings-ru-new

<!-- after: 1.2 — IDLE-STOP (простаивающие контейнеры ботов) -->
### 1.2 — hermes-local-off (вывод адаптера hermes_local)

| Переменная | По умолчанию | Описание |
| --- | --- | --- |
| `MYRMIDON_DISABLE_HERMES_LOCAL` | не задана | Значение `1` выключает адаптер `hermes_local` для нового выбора и показывает его выключенным. Любое другое значение или отсутствие: без изменений. |
