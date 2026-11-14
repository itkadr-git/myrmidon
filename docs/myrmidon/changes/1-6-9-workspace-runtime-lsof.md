---
settings-section: Track 3 — tool gateway and Hermes adapter
---

## changelog-en

### Stop repeated lsof calls during workspace runtime port selection when lsof is missing (OPE-13075)

When preparing an isolated workspace runtime, port verification checked listener ownership via `lsof`. On environments without `lsof`, every candidate check spawned `lsof` repeatedly (~32 attempts taking ~19s total). Now, the availability of `lsof` is cached on the first missing/failed check so subsequent checks immediately return without repeated process spawns and complete within 1 second.

## changelog-ru

### Прекращение повторных запусков lsof при выборе порта рабочей копии при отсутствии lsof (OPE-13075)

При подготовке изолированной рабочей копии выбор порта проверял владельца порта через `lsof`. Если `lsof` отсутствовал в системе, продукт повторял попытки вызова до 32 раз (суммарная задержка ~19 секунд). Теперь доступность `lsof` кэшируется после первой же проверки отсутствия команды, повторные запуски исключены, а проверка укладывается в 1 секунду.
