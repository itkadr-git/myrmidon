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

## settings-en-append

<!-- after: 1.7 — SETTINGS-TO-UI E: system and monitoring settings (SystemSettingsPanel) -->

### 1.7 — SWEEP-2: sweep watchdog thresholds (githubEventsMaxSilenceMin, guardReturnIntervalSec)

The two sweep watchdog thresholds that used to be environment-only are now
instance behavior settings (section `system` of the part A registry) edited in
"Тонкие настройки". Each value resolves live on every sweep pass: a set
environment variable stays the forced override, otherwise the saved UI value
applies, otherwise the source default — a change in the interface applies
without a restart, and the behavior-settings API shows the source of each
effective value (`env`, `ui`, `default`).

| Setting key | Environment (forced override) | Default | What it does | Bounds / special |
|---|---|---|---|---|
| `githubEventsMaxSilenceMin` | `MYRMIDON_GITHUB_EVENTS_MAX_SILENCE_MIN` (legacy alias `PAPERCLIP_GITHUB_EVENTS_MAX_SILENCE_MIN`) | `15` | Maximum silence of GitHub events (minutes) before the watchdog raises the company alarm while active PRs exist | Integer > 0; the CI-stale multiplier stays at `max(threshold, 30 min)` |
| `guardReturnIntervalSec` | `MYRMIDON_GUARD_RETURN_INTERVAL_SEC` | `300` | Interval in seconds between guard-return sweep passes | Integer > 0; below the saved value the caller-supplied `deps.intervalSec` still applies, then the built-in default |

## settings-ru-append

<!-- after: 1.7 — SETTINGS-TO-UI E: системные настройки и мониторинг (SystemSettingsPanel) -->

### 1.7 — SWEEP-2: пороги сторожей проходов (githubEventsMaxSilenceMin, guardReturnIntervalSec)

Оба порога сторожей проходов, которые раньше были только переменными окружения, стали настройками поведения инстанса (раздел `system` реестра части A) и редактируются в «Тонких настройках». Каждое значение разрешается на лету на каждом проходе: заданная переменная окружения остаётся принудительным переопределением, иначе действует сохранённое в интерфейсе значение, иначе умолчание источника — изменение в интерфейсе действует без перезапуска, API behavior-settings показывает источник каждого эффективного значения (`env`, `ui`, `default`).

| Ключ настройки | Переменная (принудительное переопределение) | Умолчание | Что делает | Границы / особое |
|---|---|---|---|---|
| `githubEventsMaxSilenceMin` | `MYRMIDON_GITHUB_EVENTS_MAX_SILENCE_MIN` (прежний синоним `PAPERCLIP_GITHUB_EVENTS_MAX_SILENCE_MIN`) | `15` | Максимальная тишина событий GitHub (минуты) до подъёма тревоги компании при наличии активных PR | Целое > 0; множитель CI-stale остаётся `max(порог, 30 мин)` |
| `guardReturnIntervalSec` | `MYRMIDON_GUARD_RETURN_INTERVAL_SEC` | `300` | Интервал в секундах между проходами guard-return | Целое > 0; ниже сохранённого значения по-прежнему действует переданный вызывающим кодом `deps.intervalSec`, затем встроенное умолчание |
