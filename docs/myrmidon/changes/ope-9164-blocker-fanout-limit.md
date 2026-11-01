---
settings-section: Track 2 — wake and run core
---

## settings-en

| `blockerRootFanoutAlertLimit` (`instance_settings.general`) | 1.6.6 P1.10 | `10` | Alert limit of the blocker-graph root fan-out evaluation (`evaluateRootFanoutAlerts`): a root holding strictly more than this many blocked issues raises a `warning` alert; a root exactly at the limit does not. Read fresh on every evaluation, no restart | Whole numbers from 1 to 1000; missing, non-integer or out of bounds — the default |

## settings-ru-append

<!-- section: Трек 2 — ядро побудок и прогонов -->

| `blockerRootFanoutAlertLimit` (`instance_settings.general`) | 1.6.6 P1.10 | `10` | Порог алерта оценки root fan-out графа блокировок (`evaluateRootFanoutAlerts`): корень, держащий строго больше этого числа заблокированных задач, даёт алерт `warning`; корень ровно на пороге — нет. Читается при каждой оценке заново, без перезапуска | Целые от 1 до 1000; отсутствующее, нецелое или вне диапазона значение — умолчание |
