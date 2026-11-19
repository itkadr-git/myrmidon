## changelog-en

### Changed: omp SSH runners clone mirrored repositories with --reference and without --depth (OPE-13113)

- The git wrapper for omp SSH runners (`docker/agent-runtime/omp-ssh/git-reference/git`) previously kept caller-provided shallow clone arguments (`--depth`, `--shallow-*`) when a bare mirror existed in `/cache/git/<owner>/<repo>.git`.
- Now, when a local bare mirror exists for the target repository, the wrapper strips `--depth` and `--shallow-*` arguments and adds `--reference-if-able <mirror>`. The clone borrows objects from the mirror without creating a shallow boundary or duplicating history, keeping the clone's `.git` under 50 MB while preserving full history via alternates.
- When no mirror exists for the repository, shallow options remain intact so non-mirrored clones continue to use shallow history.
- Contract and end-to-end regression tests updated in `scripts/myrmidon/omp-ssh-image.test.mjs`.

## changelog-ru

### Изменено: omp SSH исполнители клонируют зеркальные репозитории с --reference и без --depth (OPE-13113)

- Обёртка git для omp SSH исполнителей (`docker/agent-runtime/omp-ssh/git-reference/git`) ранее сохраняла переданные аргументы shallow-клонирования (`--depth`, `--shallow-*`), даже если в `/cache/git/<owner>/<repo>.git` присутствовало зеркало.
- Теперь, если для репозитория существует локальное зеркало, обёртка удаляет аргументы `--depth` и `--shallow-*` и добавляет `--reference-if-able <зеркало>`. Клон заимствует объекты из зеркала без shallow-ограничений и без дублирования истории, сохраняя размер `.git` менее 50 МБ и предоставляя полную историю коммитов через alternates.
- Для репозиториев без зеркала shallow-аргументы сохраняются без изменений.
- Контрактные и end-to-end тесты обновлены в `scripts/myrmidon/omp-ssh-image.test.mjs`.
