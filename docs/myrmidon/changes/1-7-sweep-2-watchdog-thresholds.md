## changelog-en

### 1.7 SWEEP-2: sweep watchdog thresholds in fine settings (OPE-12629)

- The GitHub event silence threshold (`MYRMIDON_GITHUB_EVENTS_MAX_SILENCE_MIN`,
  legacy alias `PAPERCLIP_GITHUB_EVENTS_MAX_SILENCE_MIN`, default 15 minutes)
  and the guard-return sweep interval (`MYRMIDON_GUARD_RETURN_INTERVAL_SEC`,
  default 300 seconds) moved from environment-only to the behavior-settings
  registry (instance scope, section `system`) and are editable in
  "Тонкие настройки".
- Both consumers resolve the values live on every sweep pass: an explicit
  environment variable stays the forced override (the `MYRMIDON_` variable
  wins over the `PAPERCLIP_` alias), then the saved UI value, then (for
  guard-return only) the `deps.intervalSec`, then the built-in default — so a
  change in the interface applies without a restart. The CI-stale multiplier
  (never below 30 minutes) is unchanged.
- Zero, negative, and non-numeric values are rejected and fall through to the
  next source in the chain.

## changelog-ru

### 1.7 SWEEP-2: пороги сторожей проходов в тонких настройках (OPE-12629)

- Порог тишины событий GitHub (`MYRMIDON_GITHUB_EVENTS_MAX_SILENCE_MIN`,
  прежний синоним `PAPERCLIP_GITHUB_EVENTS_MAX_SILENCE_MIN`, умолчание
  15 минут) и интервал прохода guard-return (`MYRMIDON_GUARD_RETURN_INTERVAL_SEC`,
  умолчание 300 секунд) переехали из только-окружения в реестр
  behavior-settings (scope инстанса, раздел `system`) и редактируются в
  «Тонких настройках».
- Оба потребителя разрешают значения на лету на каждом проходе: явная
  переменная окружения остаётся принудительным переопределением (переменная
  `MYRMIDON_` важнее синонима `PAPERCLIP_`), затем сохранённое значение
  интерфейса, затем (только для guard-return) `deps.intervalSec`, затем
  встроенное умолчание — изменение в интерфейсе действует без перезапуска.
  Множитель CI-stale (не ниже 30 минут) не изменён.
- Нулевые, отрицательные и нечисловые значения отклоняются и откатываются
  к следующему источнику в цепочке.

## settings-en-replace

| `MYRMIDON_GITHUB_EVENTS_MAX_SILENCE_MIN` | OPE-12629 | `fallback to PAPERCLIP alias` | Maximum GitHub event silence before warning (minutes). A saved Fine settings value (`githubEventsMaxSilenceMin`, section `system`) applies on the next sweep pass without a restart; zero, negative and non-numeric saved values fall through to the next source | Behavioral override: in Fine settings (1.7); an explicit env value is the forced override over the saved one; the CI-stale multiplier stays `max(threshold, 30 min)` |
| `MYRMIDON_GUARD_RETURN_INTERVAL_SEC` | OPE-12629 | `source default` | Return-guard sweep interval in seconds. A saved Fine settings value (`guardReturnIntervalSec`, section `system`) applies on the next sweep pass without a restart; zero, negative and non-numeric saved values fall through to the next source | Behavioral override: in Fine settings (1.7); an explicit env value is the forced override over the saved one; below the saved value the caller-supplied `deps.intervalSec` still applies, then the built-in default |

## settings-ru-replace

| `MYRMIDON_GITHUB_EVENTS_MAX_SILENCE_MIN` | OPE-12629 | `fallback to PAPERCLIP alias` | Максимальная тишина событий GitHub до предупреждения (минуты). Сохранённое значение «Тонких настроек» (`githubEventsMaxSilenceMin`, раздел `system`) применяется на следующем проходе без перезапуска; нулевые, отрицательные и нечисловые значения откатываются к следующему источнику | Поведенческая настройка: в «Тонких настройках» (1.7); явное значение env — принудительное переопределение над сохранённым; множитель CI-stale остаётся `max(порог, 30 мин)` |
| `MYRMIDON_GUARD_RETURN_INTERVAL_SEC` | OPE-12629 | `source default` | Интервал прохода охранного возврата, секунды. Сохранённое значение «Тонких настроек» (`guardReturnIntervalSec`, раздел `system`) применяется на следующем проходе без перезапуска; нулевые, отрицательные и нечисловые значения откатываются к следующему источнику | Поведенческая настройка: в «Тонких настройках» (1.7); явное значение env — принудительное переопределение над сохранённым; ниже сохранённого значения по-прежнему действует переданный вызывающим кодом `deps.intervalSec`, затем встроенное умолчание |
