---
divergence-section: 1.6.1 — BOT-DISK B: общий кэш пакетов для контейнеров ботов
---

## changelog-en

### The board tells each bot which task copies it should keep (1.6.5 BOT-DISK-H, part H4a)

- New route `GET /api/myrmidon/bots/me/workspaces`, for the bot's own agent key
  only (any other actor gets 403, an anonymous call 401). It answers with the
  desired state of the bot's task copies: `active` for the bot's tasks that are
  not terminal, `closing` for tasks that are done, cancelled, hidden, reassigned
  to someone else, or whose pull request is merged (read from the work products
  that the task PR sync keeps current). A task with one merged and one still
  open pull request stays `active`.
- The repository of a copy is the Repo URL of the task's project workspace, or
  the repository of the task's latest pull request. The `grace` block follows
  `general.botDisk.graceClosingMinutes` / `scratchTtlHours` (defaults 30 min /
  24 h); `pressure` is `none` until a dockergate snapshot is wired in.
- The lifecycle rule is a pure function (`workspaceStateOf`), the answer is
  checked against the C3 schema from `@paperclipai/shared` before it is sent.

## changelog-ru

### Доска сообщает каждому боту, какие копии задач ему держать (1.6.5 BOT-DISK-H, часть H4a)

- Новый маршрут `GET /api/myrmidon/bots/me/workspaces` — только для собственного
  ключа агента-бота (другой актор получает 403, без авторизации — 401). Отвечает
  целевым состоянием копий задач бота: `active` — задачи бота, не терминальные;
  `closing` — задачи в `done`, `cancelled`, скрытые, переназначенные или с
  влитым pull request (читается из work product, которые ведёт сверка PR задач).
  Задача с одним влитым и одним ещё открытым PR остаётся `active`.
- Репозиторий копии — Repo URL рабочего пространства проекта задачи либо
  репозиторий последнего PR задачи. Блок `grace` берётся из
  `general.botDisk.graceClosingMinutes` / `scratchTtlHours` (по умолчанию
  30 мин / 24 ч); `pressure` равен `none`, пока снимок dockergate не подключён.
- Правило жизненного цикла — чистая функция (`workspaceStateOf`), ответ перед
  отправкой проверяется схемой C3 из `@paperclipai/shared`.

## divergence

| 1.6.5-BOT-DISK-H4a | Маршрут `GET /api/myrmidon/bots/me/workspaces` и вычисление `active`/`closing` по контракту C3 | Наши файлы: `server/src/myrmidon/bot-containers/bot-workspaces-routes.ts`, `bot-workspaces-service.ts`, `workspace-state.ts`, тест `bot-workspaces.myrmidon.test.ts`; строка регистрации в `server/src/app.ts` (маркер `myrmidon(1.6.5-BOT-DISK-H4a)`). Маркеров вендора нет | Проект диска ботов (BOT-DISK-H, раздел 2.3): botd удаляет копии по событию задачи, источник истины — доска. Требование тикета OPE-5358 | `bot-workspaces.myrmidon.test.ts` (таблица статус → состояние, done и merged PR → closing, переназначение, чужой актор → 403, схема C3, выбор репозитория, давление, grace) | Никогда, наше поведение. Снятие: удалить три файла и тест, строку в `app.ts` и этот фрагмент | (этот PR) |
