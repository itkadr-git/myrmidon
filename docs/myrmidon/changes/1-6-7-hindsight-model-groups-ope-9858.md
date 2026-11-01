---

---

## changelog-en

### Hindsight model groups (OPE-9858)

- Added shared Hindsight model groups for the `write`, `summarize`, and `search` roles.
- Added the server adapter and routes, with persistence in instance settings and no server restart required for reads and writes.
- Integrated the groups into the model providers screen with mapping, suggested models, save feedback, and API limitation details.
- Hot application inside a running Hindsight container remains dependent on OPE-9469.
- The UI does not edit secrets or environment variables; selected models must be available through LiteLLM or configured providers.
- Changing the search embedding model may require reindexing existing memory stores.

## changelog-ru

### Группы моделей Hindsight (OPE-9858)

- Добавлены общие группы моделей Hindsight для ролей `write`, `summarize` и `search`.
- Добавлены серверный адаптер и маршруты с сохранением в настройках инстанса; чтение и запись не требуют перезапуска сервера.
- Группы интегрированы в экран провайдеров моделей: добавлены маппинг, рекомендуемые модели, индикация сохранения и ограничения API.
- Горячее применение внутри работающего контейнера Hindsight зависит от OPE-9469.
- UI не изменяет секреты и переменные окружения; выбранные модели должны быть доступны через LiteLLM или настроенных провайдеров.
- После смены embedding-модели поиска может потребоваться переиндексация существующих хранилищ памяти.
