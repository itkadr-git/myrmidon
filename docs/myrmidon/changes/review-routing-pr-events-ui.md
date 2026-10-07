## changelog-en

### Review routing: pull-request events and merge steward settings UI (REVIEW-ROUTING PR-events UI)

- The Review routing settings screen gains a "Pull request events" section: a
  toggle for creating review tasks from green pull requests, a `owner/repo`
  list editor (empty — every repository the board sees), limits for open
  reviews per reviewer and new assignments per pass, and the poll interval.
- A "Merge steward" sub-section edits the steward toggle, its caste roles
  (comma-separated) and its per-pass merge limit; the role and limit inputs
  disable while the steward is off.
- The screen reads and writes the settings through the existing review-routing
  settings API with full-object semantics: the PUT preserves every key the
  screen does not own. Client-side validation rejects malformed repository
  entries and out-of-range numbers before the save is sent.
- The `prWatch` block is sent only when the loaded settings already carry it
  (the server schema is strict, so a pre-PR-lane server would reject the key
  with 400): against such a server the "Pull request events" and "Merge
  steward" sections stay hidden and the task-lane save works unchanged. The
  client-side `owner/repo` validation mirrors the server's repository pattern
  exactly (`[A-Za-z0-9_.-]+` halves).

## changelog-ru

### Назначение ревью: события pull request и стюард слияний — интерфейс настроек (REVIEW-ROUTING PR-events UI)

- На экране «Назначение ревью» появилась секция «События pull request»:
  переключатель создания задач ревью по зелёным pull request, редактор списка
  репозиториев в формате `owner/repo` (пустой список — все репозитории, которые
  видит доска), лимиты открытых ревью на ревьюера и новых назначений за проход,
  и интервал опроса.
- Подсекция «Стюард слияний» правит переключатель стюарда, его роли каст
  (через запятую) и лимит слияний за проход; поля ролей и лимита отключаются,
  пока стюард выключен.
- Экран читает и сохраняет настройки через существующий API настроек
  назначения ревью с полной семантикой объекта: PUT сохраняет все ключи,
  которые экран не редактирует. Клиентская валидация отклоняет некорректные
  записи репозиториев и числа вне диапазона до отправки сохранения.
- Блок `prWatch` отправляется только если загруженные настройки уже его
  содержат (схема сервера строгая: сервер без PR-полосы отверг бы ключ с 400);
  против такого сервера секции «События pull request» и «Стюард слияний»
  скрыты, а сохранение дорожной полосы задач работает как раньше. Клиентская
  проверка записей `owner/repo` в точности повторяет серверный шаблон
  (`[A-Za-z0-9_.-]+` в обеих половинах).
