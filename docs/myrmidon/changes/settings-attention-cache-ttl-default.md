## changelog-en

### Correct the attention feed cache TTL default in the settings docs

- The English and Russian settings guides now show the current default of 60 seconds, not 45 seconds. The runtime default does not change.
- Correct the SETTINGS-UI C-4 row in the Russian settings registry to 60 seconds when the release collects this fragment.

## changelog-ru

### Исправлено умолчание TTL кэша ленты внимания в документации настроек

- В английском и русском руководствах указано действующее умолчание 60 секунд вместо 45 секунд. Поведение кода не меняется.
- При сборке релиза строка SETTINGS-UI C-4 в русском реестре настроек исправляется на 60 секунд.

## settings-ru-replace

| `attentionFeedCacheTtlSeconds` | 1.6.6-SETTINGS-UI C-4 | `60` | Сколько секунд собранная лента внимания переиспользуется для компании до пересборки при следующем чтении | Целые секунды от 0 до 300; `0` выключает кэш. Отсутствующее, нецелое или выходящее за границы сохранённое значение читается как умолчание |
