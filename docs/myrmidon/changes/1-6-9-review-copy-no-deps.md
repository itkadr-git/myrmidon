## changelog-en

### `myr-ws open --review`: a review copy without a working directory (OPE-13111)

- Reviewers held 14–17 full copies of 0.5–1.2 GB each. `myr-ws open <KEY> <owner/repo> --review` now creates a worktree
  without a working directory (`git worktree add --no-checkout` with an empty sparse-checkout, so `git status` stays
  clean): only the `.git` file and metadata, a review copy without a working directory takes kilobytes instead of ~0.5 GB.
  No dependencies are installed and git hooks are switched off.
- Before the copy is attached, the PR branch is fetched from the remote and a stale local branch is fast-forwarded to
  `origin/<branch>`. If the branch is not on the remote and `--branch` is not given, `open` fails with "no PR branch,
  pass --branch" instead of silently opening a copy of main. A local branch with commits that are not on the remote is
  not moved (error).
- The reviewer reads the change by refs: `gh pr diff <N>`, `git diff origin/main...HEAD`, `git show HEAD:<path>`. An
  already open copy is returned as it is, with a warning when `--review` was asked. `--review` cannot be combined with
  `--scratch`. Plain `open` is unchanged. The reviewer skill and the bot-runtime READMEs describe the mode.

## changelog-ru

### `myr-ws open --review`: копия для ревью без рабочего каталога (OPE-13111)

- У ревьюеров лежало по 14–17 полных копий по 0,5–1,2 ГБ. Теперь `myr-ws open <KEY> <owner/repo> --review` создаёт
  worktree без рабочего каталога (`git worktree add --no-checkout` и пустой sparse-checkout, чтобы `git status` оставался
  чистым): только файл `.git` и метаданные; копия ревью без рабочего каталога — килобайты вместо ~0,5 ГБ. Зависимости не
  ставятся, git-хуки отключены.
- Перед подключением ветка PR забирается с remote, устаревшая локальная ветка переводится вперёд на `origin/<ветка>`.
  Если ветки на remote нет и `--branch` не задан, `open` отвечает ошибкой «нет ветки PR, укажи --branch», а не тихо
  открывает копию main. Локальная ветка с коммитами, которых нет на remote, не двигается (ошибка).
- Ревьюер читает изменения по ссылкам: `gh pr diff <N>`, `git diff origin/main...HEAD`, `git show HEAD:<путь>`. Уже
  открытая копия возвращается как есть, с предупреждением, если запрошен `--review`. `--review` нельзя сочетать с
  `--scratch`. Обычный `open` не менялся. Режим описан в навыке ревьюера и README bot-runtime.
