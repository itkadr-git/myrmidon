---
divergence-section: Трек 5 — эксплуатация
---

## changelog-en

### `myr-ws open` repairs a copy a run left half-way; `--branch` / `--repository`; the task's PR picks the workspace (MYR-WS-RECOVER)

- A reused task copy is no longer returned as it is. `myr-ws open` first looks for a merge, rebase,
  cherry-pick, revert or `git am` in progress, unresolved index stages, a detached head and a branch
  other than the registry (or `--branch`) names. Found: the whole state (HEAD, the index with the
  conflicts as files, the working tree, untracked files) is saved as a commit in
  `refs/myr-ws/recovery/<KEY>` (`-2`, `-3`, ... when taken), then the operation is aborted
  (`merge --abort`, `rebase --abort`, ...). If that does not clean the copy, the worktree is recreated
  on the same branch. Local changes that block a branch switch go to the stash. The answer says what was
  done: `recovered: [{problem, action, detail}]` and `recoveryRef` in `--json`, one line on stderr
  otherwise. A branch the bot moved the copy to on its own is adopted into the registry (nothing on disk
  changes); a worktree whose git directory is gone is moved aside and replaced.
- `myr-ws open KEY owner/repo --branch <name>` opens (or moves the copy to) that branch, taken from its
  remote state, instead of `bot/<KEY>`; `--repository owner/repo` is the named form of the positional.
- The hermes gateway adapter takes the repository and the head branch of the task's own pull request
  work product (`context.paperclipPullRequest`, filled by the server per run), and uses the project's
  repository only as a fallback, then the instance default. A PR of another repository than the
  project's (OPE-7967, PR #82 of `myrmidon-deploy`) no longer fails every run with "already open for ...".
- A run interrupted mid-merge (maintenance drain, kill) is repaired by botd: when no run is going or
  possibly going, each pass calls the new `myr-ws repair [KEY]`, which applies the same recovery to
  copies with no process working inside them.

## changelog-ru

### `myr-ws open` чинит копию, оставленную прогоном на полпути; `--branch` / `--repository`; рабочая копия берётся из PR задачи (MYR-WS-RECOVER)

- Повторно используемая копия задачи больше не отдаётся как есть. `myr-ws open` сначала ищет
  незавершённые слияние, rebase, cherry-pick, revert и `git am`, неразрешённые стадии индекса,
  отсоединённую голову и ветку, не совпадающую с реестром (или с `--branch`). Если нашёл, всё состояние
  (HEAD, индекс с конфликтами в виде файлов, рабочее дерево, неотслеживаемые файлы) сохраняется коммитом
  в `refs/myr-ws/recovery/<KEY>` (`-2`, `-3`, ... если имя занято), затем операция отменяется
  (`merge --abort`, `rebase --abort`, ...). Если копия не очистилась, рабочее дерево пересоздаётся на
  той же ветке. Локальные изменения, мешающие смене ветки, уходят в stash. В ответе сказано, что
  сделано: `recovered: [{problem, action, detail}]` и `recoveryRef` в `--json`, иначе строка в stderr.
  Ветку, на которую бот сам перевёл копию, реестр принимает как есть (на диске ничего не меняется);
  рабочее дерево с потерянным git-каталогом откладывается в сторону и создаётся заново.
- `myr-ws open KEY owner/repo --branch <имя>` открывает копию на этой ветке (или переводит на неё) по её
  удалённому состоянию вместо `bot/<KEY>`; `--repository owner/repo` — именованная форма позиционного
  репозитория.
- Адаптер hermes берёт репозиторий и ветку головы из рабочего продукта «pull request» самой задачи
  (`context.paperclipPullRequest`, сервер заполняет на каждый прогон), репозиторий проекта —
  запасной вариант, затем умолчание инстанса. PR другого репозитория, чем у проекта (OPE-7967, PR #82
  `myrmidon-deploy`), больше не роняет каждый прогон ошибкой «already open for ...».
- Прогон, прерванный посреди слияния (окно обслуживания, kill), чинит botd: когда прогона нет и быть
  не может, каждый проход вызывает новую `myr-ws repair [KEY]`, которая применяет то же восстановление
  к копиям, в которых не работает ни один процесс.

## divergence

| 1.6.6-MYR-WS-RECOVER | `myr-ws open` чинит копию, оставленную на полпути (слияние/rebase/cherry-pick, стадии, отсоединённая голова, чужая ветка) с сохранением состояния в `refs/myr-ws/recovery/<KEY>`; ключи `--branch`/`--repository`; глагол `repair` и проход botd; поле `branch` в `workspace` адаптера hermes и `context.paperclipPullRequest` из рабочего продукта PR | `+ docker/bot-runtime/myr-ws/lib/recover.js`, `+ docker/bot-runtime/myr-ws/lib/repair.js`, `+ docker/bot-runtime/botd/lib/repair.js`, `docker/bot-runtime/myr-ws/lib/open.js`, `docker/bot-runtime/myr-ws/lib/cli.js`, `docker/bot-runtime/botd/botd`, `docker/bot-runtime/patches/10-run-workspace-open.patch`, `packages/shared/src/myrmidon-bot-workspace.ts`, `packages/adapters/hermes/src/gateway/server/execute.ts`, `+ server/src/myrmidon/run-pull-request.ts`, `server/src/services/heartbeat.ts` (метка `myrmidon(MYR-WS-RECOVER)`) | Копия OPE-6975 осталась посреди слияния после прерывания режимом обслуживания, и `open` отдал её 60 раз подряд; OPE-7967 падал на репозитории проекта вместо репозитория PR; у 26 копий ветка расходилась с реестром | `scripts/myrmidon/bot-runtime/myr-ws-recover.test.mjs`, `scripts/myrmidon/bot-runtime/botd-repair.test.mjs`, `server/src/myrmidon/run-pull-request.myrmidon.test.ts`, `packages/adapters/hermes/src/gateway/server/execute.test.ts`, `docker/bot-runtime/tests/run_workspace_open.py` | Никогда, наше поведение (слой ботов). Снимать вместе с `myr-ws` | (этот PR) |
