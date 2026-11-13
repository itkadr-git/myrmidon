# Cutting a release candidate (`cut-rc.mjs`)

> Русская версия ниже / Russian version below.

One command cuts the release candidate tag `myr-vX.Y.Z-rc.N`. It replaces the
ad-hoc host scripts (`ops/auto/rc167-*-go.sh`, the `rc-gate.sh` that was not
wired into every one of them) after the 12.11 incident: rc.24 went out with 17
open release tasks, and six closed tasks later turned out to carry unmerged
PRs. Every candidate tag now goes through the same checks, and every bypass
lands on the board.

## The command

```bash
node scripts/myrmidon/release/cut-rc.mjs --version 1.7.0 --rc 25
```

The script checks, in order:

1. **Board — open tasks.** Every issue carrying the release label
   (`--board-label`, default: `<major>.<minor>` of `--version`, e.g. `1.7`)
   must be `done`. Open tasks are a refusal with the list.
2. **Board — unmerged attached PRs.** Every issue of the release (including
   `done` ones — the silent failure mode of 12.11) must have no attached PR
   in state `open`, `draft` or `closed` without a merge. The check reads the
   `pull_request` work products of each issue from the board API.
3. **Composition — deliveries on the candidate commit.** Every `done` task
   of the release must have its work on the commit the tag would point to:
   a merged PR counts when its merge commit is an ancestor of the release
   commit; a task without a merged PR counts when some commit on the branch
   mentions the task id in the subject (`OPE-NNNN` as a whole token). A
   merged PR whose merge commit is missing from the branch (a main fix that
   never made it to the release, or a branch-foreign PR) is a **hard**
   refusal naming the task and the PR — it is never bypassable. A `done`
   task with no delivery trace at all is board-class: overridable like a
   stale board, listed in the same override record.
4. **Changelog.** `## X.Y.Z` exists and is non-empty in both
   `docs/myrmidon/CHANGELOG.md` and `CHANGELOG.ru.md`, and the unreleased
   section (`Unreleased` / `Без выпуска`) is empty — the same contract as
   `collect-fragments.mjs --check` (RELEASE-CUT-CHANGELOG). Fold the
   fragments first: `collect-fragments.mjs --version X.Y.Z`, land the
   release-cut PR, then cut the tag from `main`.
5. **Git.** The tag must be new and the commit must sit on the default
   branch (`--branch` overrides; the commit is `origin/<branch>` HEAD,
   `--sha` overrides).
6. **CI.** `gh run list` for the commit must show every run completed and
   successful (skipped/neutral do not block). A red, running or missing CI
   is a hard refusal — CI is never bypassable, and there is no flag to skip
   the check.

On any violation the script prints the full list and exits 1 without
tagging.

## Bypass (override) — always on the board

A stale board (the label list no longer reflects reality) can be bypassed
only with an explicit reason and the release journal issue:

```bash
node scripts/myrmidon/release/cut-rc.mjs --version 1.7.0 --rc 25 \
  --override "rc.24 already shipped; the open list is stale (closed 13.11)" \
  --journal OPE-12408
```

- `--override` requires non-empty text and `--journal OPE-NNNN`.
- The script posts the record to the journal issue BEFORE tagging: the tag,
  the reason, the violation list and the open-task list. If the post fails,
  the cut is refused — no silent bypasses (owner decision 12.11, item 4a).
- Changelog, git and CI problems are NOT bypassable: an override covers
  stale board state only — including the board-class composition gaps (a
  `done` task with no delivery trace). A merged PR missing from the release
  commit is a fact about the repository, never bypassable. Fix the
  repository or pick a green commit.

## Flags

| flag | meaning |
| --- | --- |
| `--version X.Y.Z` | release version (required) |
| `--rc N` | candidate number, tag `myr-vX.Y.Z-rc.N` (required) |
| `--override "text"` | bypass board violations with a reason |
| `--journal OPE-NNNN` | board issue receiving the override record |
| `--branch <name>` | branch to verify/tag (default: `origin/HEAD`, fallback `main`) |
| `--sha <sha>` | commit to tag (default: tip of `--branch`) |
| `--board-label NAME` | release label (default: `<major>.<minor>`) |
| `--root <dir>` | repository root (default: cwd) |
| `--dry-run` | run all checks, print the plan, tag nothing |

There is no flag that skips the CI check: a production invocation always
verifies that CI of the release commit is green (`gh run list`), and a
missing, running, red or unverifiable CI is a hard refusal. Tests inject a
fake CI checker through the module API (`run(args, { ciStatus })`).

## Environment

`PAPERCLIP_API_URL` (default `http://127.0.0.1:3100`), `PAPERCLIP_API_KEY`,
`PAPERCLIP_COMPANY_ID` for the board API; `gh` (with `GITHUB_TOKEN` or an
existing auth) for CI; `git` for tagging. The script never pushes the tag —
run `git push origin myr-vX.Y.Z-rc.N` yourself after checking the output.

Exit codes: `0` tagged (or dry-run clean), `1` refusal, `2` usage error.

Tests: `scripts/myrmidon/release/cut-rc.test.mjs` (the board API and `gh`
are faked, `git` is a throwaway repo per test: open task → refusal; done
task with an unmerged PR → refusal; merged PR missing from the branch →
hard refusal; done task with no delivery → overridable refusal; clean →
tag; override → tag + board comment; failed comment post → refusal; red
CI → refusal even with an override).

---

# Нарезка кандидата выпуска (`cut-rc.mjs`)

Одна команда ставит тег кандидата `myr-vX.Y.Z-rc.N`. Она заменяет
разрозненные хостовые скрипты (`ops/auto/rc167-*-go.sh`, подключённый не
везде `rc-gate.sh`) после инцидента 12.11: rc.24 вышел при 17 открытых
задачах выпуска, а позже выяснилось, что у шести закрытых задач PR не
влиты. Каждый кандидат теперь проходит одни и те же проверки, и каждый
обход попадает на доску.

## Команда

```bash
node scripts/myrmidon/release/cut-rc.mjs --version 1.7.0 --rc 25
```

Проверки по порядку:

1. **Доска — открытые задачи.** Каждая задача с меткой выпуска
   (`--board-label`, по умолчанию `<major>.<minor>` из `--version`, для 1.7 —
   `1.7`) должна быть `done`. Открытые задачи — отказ со списком.
2. **Доска — невлитые привязанные PR.** У каждой задачи выпуска (включая
   закрытые — тихий режим отказа 12.11) не должно быть привязанного PR в
   состоянии `open`, `draft` или `closed` без слияния. Проверка читает
   work products типа `pull_request` каждой задачи через API доски.
3. **Состав выпуска — поставки на кандидате.** У каждой `done`-задачи
   выпуска работа должна быть на коммите, куда встанет тег: влитой PR
   засчитывается, когда его merge-коммит — предок релизного коммита; задача
   без влитого PR засчитывается, когда на ветке есть коммит, в чьём subject
   упомянут идентификатор задачи (`OPE-NNNN` целым токеном). Влитой PR,
   чей merge-коммит отсутствует на ветке (фикс из main не доехал до
   релиза, или PR чужой ветки) — **жёсткий** отказ с именем задачи и
   номера PR, обхода нет и не будет. `done`-задача без всякого следа
   поставки — класс доски: обходится как устаревшая доска, попадает в ту
   же запись обхода.
4. **Журнал.** Секция `## X.Y.Z` есть и непуста в обоих
   `docs/myrmidon/CHANGELOG.md` и `CHANGELOG.ru.md`, секция «Unreleased» /
   «Без выпуска» пуста — тот же контракт, что `collect-fragments.mjs
   --check` (RELEASE-CUT-CHANGELOG). Сначала собери фрагменты:
   `collect-fragments.mjs --version X.Y.Z`, влей release-cut PR, затем
   ставь тег на `main`.
5. **Git.** Тег должен быть новым, коммит — на основной ветке (`--branch`;
   коммит — HEAD `origin/<branch>`, можно `--sha`).
6. **CI.** `gh run list` по коммиту: все прогоны завершены и успешны
   (skipped/neutral не блокируют). Красный, идущий или отсутствующий CI —
   жёсткий отказ. CI не обходится, и флага пропуска проверки не существует.

При любом нарушении скрипт печатает полный список и завершается с кодом 1,
не ставя тег.

## Обход — всегда через доску

Устаревшее состояние доски можно обойти только с явной причиной и задачей-
журналом выпуска:

```bash
node scripts/myrmidon/release/cut-rc.mjs --version 1.7.0 --rc 25 \
  --override "rc.24 уже вышел; список открытого устарел (закрыто 13.11)" \
  --journal OPE-12408
```

- `--override` требует непустого текста и `--journal OPE-NNNN`.
- Скрипт пишет запись в задачу-журнал ДО постановки тега: тег, причина,
  список нарушений и открытых задач. Если пост не удался — отказ, тихих
  обходов нет (решение владельца 12.11, п. 4а).
- Журнал, git и CI НЕ обходятся: override покрывает только устаревшее
  состояние доски — включая провалы состава класса доски (`done`-задача
  без следа поставки). Влитой PR, отсутствующий на релизном коммите, —
  факт о репозитории, обхода нет. Чини репозиторий или бери зелёный
  коммит.

## Флаги

| флаг | значение |
| --- | --- |
| `--version X.Y.Z` | версия выпуска (обязателен) |
| `--rc N` | номер кандидата, тег `myr-vX.Y.Z-rc.N` (обязателен) |
| `--override "текст"` | обход нарушений доски с причиной |
| `--journal OPE-NNNN` | задача доски для записи об обходе |
| `--branch <имя>` | ветка для проверки/тега (по умолчанию `origin/HEAD`, иначе `main`) |
| `--sha <sha>` | коммит для тега (по умолчанию верх `--branch`) |
| `--board-label ИМЯ` | метка выпуска (по умолчанию `<major>.<minor>`) |
| `--root <dir>` | корень репозитория (по умолчанию cwd) |
| `--dry-run` | все проверки без постановки тега |

Флага, пропускающего проверку CI, не существует: боевой запуск всегда
проверяет зелёный CI коммита выпуска (`gh run list`), а отсутствующий,
идущий, красный или непроверяемый CI — жёсткий отказ. Тесты подменяют
проверку CI через API модуля (`run(args, { ciStatus })`).

## Окружение

`PAPERCLIP_API_URL` (по умолчанию `http://127.0.0.1:3100`),
`PAPERCLIP_API_KEY`, `PAPERCLIP_COMPANY_ID` для API доски; `gh` (с
`GITHUB_TOKEN` или готовым логином) для CI; `git` для тега. Скрипт никогда
не пушит тег — после проверки вывода запусти
`git push origin myr-vX.Y.Z-rc.N` сам.

Коды выхода: `0` — тег поставлен (или dry-run чист), `1` — отказ,
`2` — ошибка использования.

Тесты: `scripts/myrmidon/release/cut-rc.test.mjs` (API доски и `gh`
подменены, `git` — одноразовый репозиторий на тест: открытая задача →
отказ; закрытая задача с невлитым PR → отказ; влитой PR вне ветки →
жёсткий отказ; `done` без поставки → обходаемый отказ; всё чисто → тег;
обход → тег и комментарий на доске; неудавшийся пост комментария → отказ;
красный CI → отказ даже с обходом).
