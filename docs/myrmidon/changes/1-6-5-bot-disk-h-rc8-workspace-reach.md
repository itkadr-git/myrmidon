---
divergence-section: 1.6.1 — BOT-DISK A: жизненный цикл черновиков бота
settings-section: BOT-DISK E — host disk usage signal
---

## changelog-en

### The workspace mechanism reaches every bot and every task (1.6.5 BOT-DISK-H, rc.8: parts H4b/H5d)

- New instance setting `general.botDisk.defaultRepo` (`owner/repo`, empty by default;
  `PATCH /api/myrmidon/bot-disk` accepts `""`/`null` to clear it). It is the last-resort
  repository of a task: the run's `workspace` field and the desired state of the bot
  workspaces (`GET /api/myrmidon/bots/me/workspaces`) take the repository from the task's
  project, then from its latest pull request, then from `defaultRepo`. A task with no
  repository at all works as before, in `/scratch`, with the warning. Most dev tasks have
  neither a project nor a pull request, so without it the board never asked a bot for a
  working copy and every clone landed in `/scratch` (class G, 24 h TTL).
- botd learns its own key: the board writes `MYRMIDON_BOT_KEY=<bot id>` into the bot's
  `.env` (an id, not a secret), so a report that does not carry `botKey` is accepted under
  the caller's key (a body naming another bot is still 403). Until the bot's profile is
  re-applied after the update, its reports are refused as before.
- Disk pressure reaches the bots: the desired state's `pressure` is built from the measured
  partition (`soft` from `partitionThresholdPercent`, `hard` from
  `partitionRefuseOpenPercent`), not the constant `none`; `disk-state.json` and
  `myr-ws open` follow it.
- botd also takes the directories that already lie on the disk: copies that predate the
  mechanism (class X, kept in `/workspace/<KEY>` outside the registry) are archived when
  they hold unpushed work and removed under the same TTL/grace and the same live-task
  protection as scratch copies; their age ignores `.git` activity (a background fetch no
  longer resets the TTL).
- The workspace mechanism — the git wrapper, `myr-ws`, `botd` and Node 24 for them — is
  built into the base `runtime` stage of `docker/bot-runtime/Dockerfile`, so the default
  image and the Node.js variant carry it too, not only the development variant. A bot of
  any variant can now report to the board and have its old copies reaped.

## changelog-ru

### Механизм рабочих копий доходит до каждого бота и каждой задачи (1.6.5 BOT-DISK-H, rc.8: части H4b/H5d)

- Новая настройка экземпляра `general.botDisk.defaultRepo` (`owner/repo`, по умолчанию
  пусто; `PATCH /api/myrmidon/bot-disk` принимает `""`/`null` для сброса). Это запасной
  репозиторий задачи: поле `workspace` прогона и желаемое состояние рабочих копий
  (`GET /api/myrmidon/bots/me/workspaces`) берут репозиторий из проекта задачи, затем из
  её последнего pull request, затем из `defaultRepo`. Задача вовсе без репозитория
  работает как раньше — в `/scratch` с предупреждением. У большинства dev-задач нет ни
  проекта, ни PR, поэтому без этой настройки доска не просила у бота рабочую копию, и
  каждый клон ложился в `/scratch` (класс G, TTL 24 ч).
- botd узнаёт свой ключ: доска пишет в `.env` бота `MYRMIDON_BOT_KEY=<id бота>` (это id,
  не секрет), и отчёт без `botKey` принимается под ключом вызывающего (тело с чужим
  ботом по-прежнему 403). Пока профиль бота не применён заново после обновления, его
  отчёты отклоняются, как раньше.
- Давление диска доходит до ботов: `pressure` в желаемом состоянии строится по
  измеренному разделу (`soft` с `partitionThresholdPercent`, `hard` с
  `partitionRefuseOpenPercent`), а не константой `none`; за ним следуют `disk-state.json`
  и `myr-ws open`.
- botd берёт и каталоги, что уже лежат на диске: копии, созданные до механизма (класс X,
  в `/workspace/<KEY>` вне реестра), архивируются при незапушенной работе и удаляются
  по тем же TTL/grace и с той же защитой живой задачи, что и scratch-копии; их возраст не
  зависит от активности в `.git` (фоновый fetch больше не обнуляет TTL).
- Механизм рабочих копий — обёртка git, `myr-ws`, `botd` и Node 24 для них — собирается
  в базовой стадии `runtime` файла `docker/bot-runtime/Dockerfile`, поэтому его несут и
  образ по умолчанию, и вариант с Node.js, а не только образ разработки. Бот любого
  варианта теперь отчитывается доске, и его старые копии убираются.

## divergence

| 1.6.5-BOT-DISK-H4b-RC8 | `general.botDisk.defaultRepo` — запасной репозиторий задачи без проекта и PR: `repo` в желаемом состоянии (`bot-workspaces-service.ts`) и поле `workspace` прогона (адаптер `hermes_gateway`, `execute.ts`, значение приходит в контексте прогона `paperclipBotDiskDefaultRepo`); механизм `myr-ws`/`botd`/обёртка git и Node 24 переезжают в базовую стадию `runtime` Dockerfile | Файлы вендора: `server/src/services/heartbeat.ts` (блок с маркером `myrmidon(1.6.5-BOT-DISK-H4b)` после `paperclipWorkspaces`), `packages/adapters/hermes/src/gateway/server/execute.ts` (`buildWorkspaceField`, маркер `myrmidon(1.6.5-BOT-DISK-H4b)`). Наши файлы: `packages/shared/src/myrmidon-bot-disk.ts`, `bot-workspaces-service.ts`, `docker/bot-runtime/Dockerfile`, `scripts/myrmidon/bot-runtime/dockerfile.test.mjs` | Проект диска ботов, дефекты D2 и D9 (разбор боя 07.10.2026): у dev-задач нет проекта и PR — доска не создавала копии; механизм стоял только на dev-образе | `execute.test.ts` (запасной репозиторий, приоритет проекта, мусорное значение), `bot-workspaces.myrmidon.test.ts`, `bot-disk-cache.myrmidon.test.ts` (схема, merge, сброс), `dockerfile.test.mjs` (механизм в базовой стадии, не повторён в dev) | Никогда, наше поведение. Снятие: убрать блок в `heartbeat.ts` и ветку `paperclipBotDiskDefaultRepo` в `buildWorkspaceField`, вернуть блок установки в стадию `runtime-dev` | (этот PR) |

## settings-en

| `general.botDisk.defaultRepo` | 1.6.5-BOT-DISK-H | unset (empty) | Repository `owner/repo` used when a task has neither a project repository nor a pull request: the run's `workspace` field and the desired state of the bot workspaces then point at it; without it such a task works in `/scratch` with a warning | `owner/repo` only (letters, digits, `_ . -`); `""`/`null` in `PATCH /api/myrmidon/bot-disk` clears it |

## settings-ru

| `general.botDisk.defaultRepo` | 1.6.5-BOT-DISK-H | не задано (пусто) | Репозиторий `owner/repo`, который берётся, когда у задачи нет ни репозитория проекта, ни pull request: поле `workspace` прогона и желаемое состояние рабочих копий указывают на него; без него такая задача работает в `/scratch` с предупреждением | Только `owner/repo` (буквы, цифры, `_ . -`); `""`/`null` в `PATCH /api/myrmidon/bot-disk` сбрасывают |
