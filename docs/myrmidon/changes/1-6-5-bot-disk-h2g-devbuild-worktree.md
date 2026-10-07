## changelog-en

### `devbuild` understands a git worktree copy (1.6.5 BOT-DISK-H, part H2g)

- A task copy opened as a worktree of the bot's bare base has a one-line `.git`
  file (`gitdir: <base>/worktrees/<name>`) instead of a `.git` directory.
  `devbuild` now resolves it (`resolve_git_dir`: plain clone, worktree with an
  absolute or relative gitdir, or neither), ships the bare base (without other
  worktrees' admin directories) and this worktree's admin directory to a
  per-bot place in `/srv/devcache/git-wt/` on the build VPS, and repoints the
  `.git` file and the admin directory's back-reference at the VPS paths, so
  every git command in the synced copy works. Only bases under
  `/data/hermes/.myrmidon/git-base` are shipped; anything else is refused.
- A plain clone, including the `--reference` clone with alternates, is synced
  exactly as before.
- Fixed: a missing `$HERMES_HOME/.env` made `devbuild` exit silently under
  `pipefail`.

## changelog-ru

### `devbuild` понимает копию-worktree (1.6.5 BOT-DISK-H, часть H2g)

- Копия задачи, открытая как worktree от bare-базы бота, вместо каталога `.git`
  содержит однострочный файл `.git` (`gitdir: <база>/worktrees/<имя>`).
  `devbuild` теперь его разбирает (`resolve_git_dir`: обычный клон, worktree с
  абсолютным или относительным gitdir, либо ничего), переносит на сборочный
  VPS bare-базу (без служебных каталогов чужих worktree) и служебный каталог
  этого worktree в отдельное для бота место `/srv/devcache/git-wt/` и
  переписывает файл `.git` и обратную ссылку служебного каталога на пути VPS,
  так что все команды git в синхронизированной копии работают. Переносятся
  только базы из `/data/hermes/.myrmidon/git-base`, остальное отклоняется.
- Обычный клон, в том числе с `--reference` и alternates, синхронизируется как
  раньше.
- Исправлено: отсутствие `$HERMES_HOME/.env` молча завершало `devbuild` из-за
  `pipefail`.
