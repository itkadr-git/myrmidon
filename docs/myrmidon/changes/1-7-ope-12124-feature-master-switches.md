---
settings-section: Track 5 — operations
---

## settings-en

| `MYRMIDON_FORAGING_ENABLED` | OPE-12124 | `true` | Master switch for the foraging comparison pass. A saved Fine settings value applies on the next pass without a restart | An explicit environment value is the forced override; otherwise save the switch in Fine settings |
| `MYRMIDON_BASELINE_ENABLED` | OPE-12124 | `true` | Master switch for baseline snapshot work. A saved Fine settings value applies without a restart | `false`/`0`/`no`/`off` disables it; the environment value overrides the saved value |
| `MYRMIDON_CTO_CHAT_ENABLED` | OPE-12124 | `true` | Master switch for the configured CTO chat planner. Routes read it on every request | `false`/`0`/`no`/`off` disables it; the environment value overrides the saved value |
| `MYRMIDON_EVALS_ENABLED` | OPE-12124 | `true` | Master switch for the configured evaluations judge. The next evaluation reads the current value | `false`/`0`/`no`/`off` disables it; the environment value overrides the saved value |

## settings-ru

| `MYRMIDON_FORAGING_ENABLED` | OPE-12124 | `true` | Главный переключатель прохода сравнения Foraging. Сохранённое значение «Тонких настроек» применяется на следующем проходе без перезапуска | Явное значение env — принудительное; иначе переключатель задаётся в «Тонких настройках» |
| `MYRMIDON_BASELINE_ENABLED` | OPE-12124 | `true` | Главный переключатель снимков Baseline. Сохранённое значение применяется без перезапуска | `false`/`0`/`no`/`off` выключает; значение env имеет приоритет над сохранённым |
| `MYRMIDON_CTO_CHAT_ENABLED` | OPE-12124 | `true` | Главный переключатель настроенного планировщика CTO Chat. Маршруты читают его на каждый запрос | `false`/`0`/`no`/`off` выключает; значение env имеет приоритет над сохранённым |
| `MYRMIDON_EVALS_ENABLED` | OPE-12124 | `true` | Главный переключатель настроенного судьи Evals. Следующая оценка читает текущее значение | `false`/`0`/`no`/`off` выключает; значение env имеет приоритет над сохранённым |
