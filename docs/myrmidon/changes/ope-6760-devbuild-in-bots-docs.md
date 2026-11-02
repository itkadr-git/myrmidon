## changelog-en

### Documentation for devbuild in bot containers (OPE-6760)

- Documented `DEVBUILD_SSH_KEY_DATA`, `MYRMIDON_DEVBUILD_CHECK`, and `MYRMIDON_LOCAL_NODE_HEAP_MB` in bot-runtime README.
- Added Russian translations for devbuild settings in `SETTINGS.ru.md`.

## changelog-ru

### Документация devbuild в контейнерах ботов (OPE-6760)

- В README bot-runtime задокументированы `DEVBUILD_SSH_KEY_DATA`, `MYRMIDON_DEVBUILD_CHECK` и `MYRMIDON_LOCAL_NODE_HEAP_MB`.
- В `SETTINGS.ru.md` добавлены русские строки настроек devbuild.

## settings-ru-append

<!-- section: Контейнеры ботов (G-серия, план 28.09 «вариант Б») -->

| `MYRMIDON_DEVBUILD_CHECK` | DEVBUILD-IN-BOTS | `1` | Самопроверка старта бота: при заданном `DEVBUILD_HOST` entrypoint выполняет `devbuild 'true'` и пишет итог в лог и в `${HERMES_HOME}/.myrmidon/devbuild-check.json`. Никогда не фатальна. `0` отключает проверку | Только боты dev-варианта; боты без `DEVBUILD_HOST` молчат в любом случае |
| `MYRMIDON_LOCAL_NODE_HEAP_MB` | DEVBUILD-IN-BOTS | `2048` | Потолок кучи (МБ), который обёртки сборки ставят тяжёлым командам, идущим внутри контейнера бота (проход гейта devbuild или прямой путь к бинарю). `0` отключает потолок; собственный `--max-old-space-size` вызывающего в `NODE_OPTIONS` всегда побеждает | Предохранитель на период раскатки; цель флота — 0 локальных запусков tsc/vitest |
