---
settings-section: Track 3 — tool gateway and Hermes adapter
---

## changelog-en

### Fallback to procfs for port ownership and avoid repeated lsof calls when lsof is missing (OPE-13075)

When preparing an isolated workspace runtime, port verification checked listener ownership via `lsof`. On Linux environments without `lsof`, every candidate check spawned `lsof` repeatedly (~32 attempts taking ~19s total). Now, the absence of `lsof` is cached on the first missing/failed check (ENOENT/127), and Linux systems fall back to inspecting `/proc/net/tcp` and `/proc/<pid>/fd` to verify listener ownership without accepting unrelated listeners and without repeated spawns.

## changelog-ru

### Запасной путь через procfs для определения владельца порта и предотвращение повторных запусков lsof (OPE-13075)

При подготовке изолированной рабочей копии выбор порта проверял владельца порта через `lsof`. На Linux при отсутствии `lsof` продукт повторял попытки вызова до 32 раз (суммарная задержка ~19 секунд). Теперь отсутствие `lsof` кэшируется после первой ошибки (ENOENT/127), а для определения владельца порта на Linux задействован запасной путь через `/proc/net/tcp` и дескрипторы сокетов `/proc/<pid>/fd`, предотвращая ложные коллизии и приём чужих процессов.
