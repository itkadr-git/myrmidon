## changelog-en

### Parallel helpers are no longer capped by a built-in number (HELPERS-NO-CAP)

- The helper limit used to default to 2 per agent under a built-in ceiling of 10
  (hard maximum 50). It is now unlimited by default: with no stored settings and no
  value on the agent card nothing caps the helpers. A ceiling and a per-agent default
  stay available as optional settings (1 to 1000), editable in the UI without a
  restart. The host is protected by the run-admission host-memory floor, not by a
  small helper count. See [SETTINGS.md](SETTINGS.md), section PARALLEL-HELPERS.

## settings-en-append

<!-- section: 1.6 — PARALLEL-HELPERS (delegated helper agents) -->

**HELPERS-NO-CAP.** There is no built-in limit on parallel helpers: with no stored
`parallelHelpers` settings and no value on the agent card the limit is "unlimited"
(Hermes' integer `delegation.max_concurrent_children` is written as 1000, which stands
for "no cap"). A cap is optional and is set in Settings, "Parallel helpers", without a
restart (the profile compiler re-reads it on its next tick):

| Setting | Default | What it does |
|---|---|---|
| `maxPerAgent` (ceiling) | unset = no ceiling | Highest limit any agent card may set; cards above it are clamped. Accepts 1 to 1000 |
| `defaultMaxPerAgent` | unset = no cap | What an agent gets when its card names no limit; never above the ceiling |

What protects the host is not a small helper count but the run-admission host-memory
floor (`MYRMIDON_MIN_FREE_HOST_MEMORY_MB`): new runs stay queued while host memory is
short. The capacity hint on the settings page reports uncapped agents instead of
treating them as a number.

## settings-ru-append

<!-- section: 1.6 — PARALLEL-HELPERS (делегируемые помощники агента) -->

**HELPERS-NO-CAP.** Встроенного предела на параллельных помощников нет: без сохранённых
настроек `parallelHelpers` и без значения в карточке агента предел — «без ограничения»
(целое `delegation.max_concurrent_children` для Hermes записывается как 1000, это и есть
«без предела»). Предел необязателен и задаётся в настройках «Parallel helpers» без
перезапуска (компилятор профиля перечитывает его на следующем тике):

| Настройка | По умолчанию | Что делает |
|---|---|---|
| `maxPerAgent` (потолок) | не задан = без потолка | Наибольший предел, который может задать карточка агента; больше — обрезается. От 1 до 1000 |
| `defaultMaxPerAgent` | не задан = без предела | Что получает агент, если в карточке предел не назван; не выше потолка |

Хост защищает не малое число помощников, а порог свободной памяти хоста у допуска запусков
(`MYRMIDON_MIN_FREE_HOST_MEMORY_MB`): пока памяти мало, новые запуски ждут в очереди.
Подсказка о ёмкости на странице настроек отмечает агентов без предела, а не считает их числом.

## settings-ru-append

<!-- section: 1.6.1 — GUARDRAILS (слой флагов на недоверенном входе) -->

**HELPERS-NO-CAP.** Встроенного предела на параллельных помощников нет: без сохранённых
настроек `parallelHelpers` и без значения в карточке агента предел — «без ограничения»
(целое `delegation.max_concurrent_children` для Hermes записывается как 1000, это и есть
«без предела»). Предел необязателен и задаётся в «Настройки → Параллельные помощники» без
перезапуска (компилятор профиля перечитывает его на следующем тике):

| Настройка | По умолчанию | Что делает |
|---|---|---|
| `maxPerAgent` (потолок) | не задан = без потолка | Наибольший предел, который может задать карточка агента; больше — обрезается. От 1 до 1000 |
| `defaultMaxPerAgent` | не задан = без предела | Что получает агент, если в карточке предел не назван; не выше потолка |

Хост защищает не малое число помощников, а порог свободной памяти хоста у допуска запусков
(`MYRMIDON_MIN_FREE_HOST_MEMORY_MB`): пока памяти мало, новые запуски ждут в очереди.
Подсказка о ёмкости на странице настроек отмечает агентов без предела, а не считает их числом.
