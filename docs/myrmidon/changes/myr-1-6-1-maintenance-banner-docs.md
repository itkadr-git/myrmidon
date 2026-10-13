## changelog-en

### Aggregated maintenance plaque (MAINTENANCE-BANNER)

- The maintenance banner is now always a single collapsed plaque instead of
  one line per window: the summary carries the total window count, the
  aggregate state (on / draining / ending) and an ends-by bound from the
  latest drain deadline; the expanded details keep one row per kind of
  window (scope type + state + reason, agent ids stripped), with agent ids
  only inside the expanded rows. See
  [guides/maintenance-banner.md](guides/maintenance-banner.md).

## changelog-ru

### Агрегированная плашка обслуживания (MAINTENANCE-BANNER)

- Баннер обслуживания — теперь всегда одна свёрнутая плашка вместо строки на
  окно: сводка показывает общее число окон, агрегированное состояние
  (on / draining / ending) и границу «до» по самому позднему дедлайну
  освобождения; в развёрнутых деталях — по строке на вид окна (тип области +
  состояние + причина, идентификаторы агентов вырезаны), а идентификаторы
  агентов — только внутри развёрнутых строк. См.
  [guides/maintenance-banner.ru.md](guides/maintenance-banner.ru.md).
