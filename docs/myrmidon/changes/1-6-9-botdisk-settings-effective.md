## changelog-en

### The bot-disk settings answer shows the git mirror in force, and a general PATCH keeps the other botDisk keys (OPE-13110)

- `GET /api/myrmidon/bot-disk` now also returns `effective`: `gitMirrorEnabled`, `gitMirrorRepos`, `gitMirrorReposIsDefault` (the stored settings carry no `gitMirrorRepos` key, so the built-in two repositories apply) and `sharedCacheRoles`. The settings screen no longer shows an empty field while the board mirrors two repositories.
- `PATCH /api/instance/settings/general` merges `botDisk` by key: a request naming only `scratchTtlHours` no longer erases the stored `gitMirrorRepos` and the other keys. An absent key changes nothing; `null` clears the whole block.
- SETTINGS.md: the default of `gitMirrorRepos` is the two built-in repositories (not "no mirrors"); `[]` turns the mirror off; only the `sharedCacheRoles` roles receive it; `<cache>/git` must belong to the board's process user (uid 1000 in production), otherwise new mirrors fail with EACCES.

## changelog-ru

### Ответ настроек диска ботов показывает действующее git-зеркало, а общий PATCH сохраняет остальные ключи botDisk (OPE-13110)

- `GET /api/myrmidon/bot-disk` теперь отдаёт и `effective`: `gitMirrorEnabled`, `gitMirrorRepos`, `gitMirrorReposIsDefault` (в сохранённом нет ключа `gitMirrorRepos`, действуют два встроенных репозитория) и `sharedCacheRoles`. Экран настроек больше не показывает пустое поле, пока доска зеркалирует два репозитория.
- `PATCH /api/instance/settings/general` сливает `botDisk` по ключам: запрос только с `scratchTtlHours` больше не стирает сохранённый `gitMirrorRepos` и прочие ключи. Отсутствующий ключ ничего не меняет; `null` очищает весь блок.
- SETTINGS.md: умолчание `gitMirrorRepos` — два встроенных репозитория (а не «зеркал нет»); `[]` выключает зеркало; получают его только роли из `sharedCacheRoles`; владельцем `<cache>/git` должен быть пользователь процесса доски (uid 1000 на бою), иначе новые зеркала не создаются (EACCES).
