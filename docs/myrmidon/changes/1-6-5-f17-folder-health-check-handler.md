## changelog-en

### Scheduled wiki folder health check gets its missing handler (1.6.5-F17)

- The llm-wiki plugin's hourly `folder-health-check` job no longer fails with
  «No handler registered»: the worker now registers the handler declared by
  the manifest.
- Each run logs one line per company and one summary line, and writes a
  `folderHealth` metric point (gauge 1 while no configured wiki root is
  unhealthy, 0 otherwise; labels carry the healthy/unhealthy counts).
  Companies with no wiki root configured report a not-configured status and
  are not counted as unhealthy.

## changelog-ru

### Ежечасная проверка папок вики получила отсутствовавший обработчик (1.6.5-F17)

- Задание `folder-health-check` плагина llm-wiki больше не падает раз в час с
  «No handler registered»: воркер регистрирует обработчик для ключа, который
  объявляет манифест.
- Каждый запуск пишет по строке журнала на компанию и итоговую строку, а также
  точку метрики `folderHealth` (датчик 1, пока ни одна настроенная папка вики
  не нездорова, иначе 0; метки несут счётчики healthy/unhealthy). Компании без
  настроенной папки вики отчитываются статусом «не настроено» и в нездоровые
  не попадают.
