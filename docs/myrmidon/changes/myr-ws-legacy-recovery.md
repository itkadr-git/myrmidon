## changelog-en

### `myr-ws open` safely recovers standalone legacy clones (PR #1427)

- `myr-ws open <KEY> <REPO>` can adopt a legacy standalone Git clone at the task path after verifying that it is a real standalone copy, has a recognizable GitHub origin, and matches the requested repository. An unrelated directory, linked worktree, or repository mismatch is refused without being adopted.
- Before replacing the clone with a managed worktree, the command preserves its current commit at `refs/myr-ws/recovery/<KEY>` and saves tracked and untracked working-tree changes in a Git stash named `myr-ws recovery <KEY>`. It then retains the original clone at `<path>.legacy-<KEY>` and reports `recoveryPath` and, when present, `recoveryRef` in the JSON result.
- If preserving the worktree fails or cannot be verified, `myr-ws open` stops and leaves the original copy in place. If creating the replacement worktree fails, it restores the original clone path. Running `myr-ws open` again reuses the registered managed worktree.
- An unregistered linked worktree already at the task path is adopted into the registry and reused; this supports recovery after registry loss without converting the worktree.

## changelog-ru

### `myr-ws open` безопасно восстанавливает старые самостоятельные Git-копии (PR #1427)

- `myr-ws open <KEY> <REPO>` может принять старую самостоятельную Git-копию в каталоге задачи после проверки, что это отдельная копия репозитория, у неё есть распознаваемый GitHub origin и он совпадает с запрошенным репозиторием. Посторонний каталог, связанный worktree или копия другого репозитория не принимаются.
- Перед заменой копии на управляемый worktree команда сохраняет её текущий коммит в `refs/myr-ws/recovery/<KEY>`, а отслеживаемые и неотслеживаемые изменения рабочего дерева — в Git stash с именем `myr-ws recovery <KEY>`. Исходная копия остаётся в `<path>.legacy-<KEY>`. В JSON-результате возвращаются `recoveryPath` и, если есть сохранённая ссылка на коммит, `recoveryRef`.
- Если сохранить изменения не удалось или их сохранение не прошло проверку, `myr-ws open` останавливается, не перемещая исходную копию. Если создать заменяющий worktree не удалось, команда возвращает исходную копию на прежний путь. Повторный `myr-ws open` использует уже зарегистрированный управляемый worktree.
- Если по пути задачи уже есть связанный worktree, отсутствующий в реестре, команда добавляет его в реестр и использует повторно. Это позволяет восстановиться после потери реестра без конвертации worktree.
