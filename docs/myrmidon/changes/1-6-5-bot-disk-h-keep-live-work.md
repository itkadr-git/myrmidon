---
divergence-section: 1.6.1 — BOT-DISK B: общий кэш пакетов для контейнеров ботов
settings-section: 1.6.1 — BOT-DISK B: shared package cache for bot containers
---

## changelog-en

### botd no longer deletes a repository with unsaved work while the bot has a live run (1.6.5 BOT-DISK-H)

- botd archived and removed `/scratch/repo` of a developer bot with 135 uncommitted edits during a run: any pressure level cut the scratch term to 1 hour and the run's state was never checked. Now a git directory with unsaved work (dirty or not pushed) in `/scratch` or `/workspace` is kept while a run is live, and when the run state is unknown (fail-closed); it is listed in the report as held (`unsafe-git-live-run`, `unsafe-git-run-unknown`). Pressure no longer shortens its term: it is archived and removed only without a run and after the full `scratchTtlHours` (24 h) of idle time. A run is live when the board lists an active task, a process of the container works under `/workspace` or `/scratch`, or a run woke the bot (SIGUSR1) in the last 30 minutes; for 30 minutes after botd starts the state is unknown. Clean and pushed copies and non-git data behave as before.

## changelog-ru

### botd не удаляет репозиторий с несохранённой работой, пока у бота идёт прогон (1.6.5 BOT-DISK-H)

- botd заархивировал и удалил `/scratch/repo` бота-разработчика со 135 незакоммиченными правками прямо во время прогона: любое давление сокращало срок scratch до 1 часа, а состояние прогона не проверялось. Теперь git-каталог с несохранённой работой (грязный или не запушенный) в `/scratch` и `/workspace` не трогается, пока прогон живой и пока состояние прогона неизвестно (fail-closed); в отчёте он идёт как удержанный (`unsafe-git-live-run`, `unsafe-git-run-unknown`). Давление срок больше не сокращает: архивация с удалением — только без прогона и после полного `scratchTtlHours` (24 ч) простоя. Прогон считается живым, если на доске есть активная задача, процесс контейнера работает под `/workspace` или `/scratch`, либо прогон разбудил бота (SIGUSR1) за последние 30 минут; первые 30 минут после старта botd состояние неизвестно. Чистые и запушенные копии и не-git данные ведут себя как раньше.

## divergence

| 1.6.5-BOT-DISK-H-keep-live-work | правила botd: git-каталог с несохранённой работой не удаляется при живом или неизвестном прогоне, срок не сокращается давлением (`rules.js` `runState`, `lib/runs.js`, `botd` `gather`) | Наши файлы: `docker/bot-runtime/botd/lib/rules.js`, `lib/runs.js`, `botd`, тесты. Маркеров вендора нет | botd удалил `/scratch/repo` с 135 незакоммиченными правками во время прогона | `botd-rules.test.mjs`, `botd-runs.test.mjs`, `botd-legacy.test.mjs` | Никогда, наше поведение | (этот PR) |
