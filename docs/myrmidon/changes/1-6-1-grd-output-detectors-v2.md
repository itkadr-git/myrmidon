---
settings-section: Track 2 — wake and run core
---

## changelog-en

### Flag-only guardrail detectors for run output (1.6-GRD, part A)

- New `guardrail_events` journal (migration 0311) plus a board-only read route:
  the secret/pii detectors fire on run output and record a flag-only event.
  The stored snippet has every detected secret/PII fragment replaced by a
  `[REDACTED:<subtype>]` placeholder (also in the activity log), is at most
  200 characters, and a run journals at most 20 events. Deleting a company
  removes its events; deleting a run keeps them with an empty run. Off by default; enabled per instance
  with `MYRMIDON_GUARDRAILS_OUTPUT_ENABLED=1`, detector subset with
  `MYRMIDON_GUARDRAILS_OUTPUT_CATEGORIES` (csv of `secret,pii`).

## changelog-ru

### Детекторы guardrails на выводе прогонов, только флаг (1.6-GRD, часть A)

- Новый журнал `guardrail_events` (миграция 0311) и read-route только для
  оператора: детекторы secret/pii срабатывают на вывод прогона и пишут
  flag-only событие. В сниппете (и в журнале активности) каждый найденный
  секрет/ПДн заменён на `[REDACTED:<подтип>]`, длина до 200 символов, не более
  20 событий на прогон. Удаление компании удаляет её события; удаление
  прогона оставляет событие с пустым прогоном. По умолчанию выключено; включается
  на инстансе через `MYRMIDON_GUARDRAILS_OUTPUT_ENABLED=1`, подмножество
  детекторов — `MYRMIDON_GUARDRAILS_OUTPUT_CATEGORIES` (csv `secret,pii`).

## settings-en

| `MYRMIDON_GUARDRAILS_OUTPUT_ENABLED` | 1.6-GRD | off | flag-only secret/pii detectors on run output write to the guardrail_events journal | unset or 0 |
| `MYRMIDON_GUARDRAILS_OUTPUT_CATEGORIES` | 1.6-GRD | all | csv subset of detector categories (`secret,pii`) that fire | unset |

## settings-ru

| `MYRMIDON_GUARDRAILS_OUTPUT_ENABLED` | 1.6-GRD | выкл | flag-only детекторы secret/pii на выводе прогона пишут в журнал guardrail_events | не задано или 0 |
| `MYRMIDON_GUARDRAILS_OUTPUT_CATEGORIES` | 1.6-GRD | все | csv-подмножество категорий детекторов (`secret,pii`) | не задано |
