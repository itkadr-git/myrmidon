## changelog-en

### `myr-ws open --review` opens a task copy for review without dependencies or hooks (OPE-13111)

- Reviewers held 14–17 full copies of 0.5–1.2 GB each. `myr-ws open <KEY> <owner/repo> --review` now opens the copy as a
  bare checkout of the task branch (`bot/<KEY>`, or the remote state of that branch when the repository has it): no
  dependency installation, no `node_modules`, and git hooks are switched off for the checkout.
- The plain `open` is unchanged. `--review` cannot be combined with `--scratch`. The usage line of `myr-ws` and the
  reviewer skill describe the mode; the reviewer reads the change with `gh pr diff <N>` or `git diff origin/main...HEAD`.

## changelog-ru

### `myr-ws open --review` открывает копию задачи для ревью без зависимостей и хуков (OPE-13111)

- У ревьюеров лежало по 14–17 полных копий по 0,5–1,2 ГБ. Теперь `myr-ws open <KEY> <owner/repo> --review` открывает
  копию как чистый checkout ветки задачи (`bot/<KEY>` или её состояние на удалённом репозитории, если оно там есть):
  без установки зависимостей, без `node_modules`, git-хуки на время checkout отключены.
- Обычный `open` не менялся. `--review` нельзя сочетать с `--scratch`. Строка usage `myr-ws` и навык ревьюера описывают
  режим; изменения ревьюер читает через `gh pr diff <N>` или `git diff origin/main...HEAD`.
