---
divergence-section: 1.6.1 — BOT-DISK B: общий кэш пакетов для контейнеров ботов
---

## changelog-en

### The board receives the disk report of every bot (1.6.5 BOT-DISK-H, part H4b)

- New route `POST /api/myrmidon/bots/me/disk-report`, for the bot's own agent key
  only (any other actor gets 403, an anonymous call 401). The body is checked
  against the C4 schema from `@paperclipai/shared`: a broken body is 400 and the
  previous report stays, a body over 1 MiB is 413, a report that names another
  bot is 403. The answer is `{ok, nextReportSec}` (300 s).
- The last report of each bot is kept in memory with its receive time, the same
  way the in-container clone report is; `readBotDiskReports()` hands them to the
  Attention cards and the panel. The clone report path is unchanged.

## changelog-ru

### Доска принимает отчёт о диске каждого бота (1.6.5 BOT-DISK-H, часть H4b)

- Новый маршрут `POST /api/myrmidon/bots/me/disk-report` — только для собственного
  ключа агента-бота (другой актор получает 403, без авторизации — 401). Тело
  проверяется схемой C4 из `@paperclipai/shared`: битое тело — 400, прошлый отчёт
  остаётся; тело больше 1 МиБ — 413; отчёт с ключом другого бота — 403. Ответ —
  `{ok, nextReportSec}` (300 с).
- Последний отчёт каждого бота хранится в памяти со временем приёма, так же как
  отчёт о клонах из контейнера; `readBotDiskReports()` отдаёт их карточкам Attention
  и панели. Путь отчёта о клонах не менялся.

## divergence

| 1.6.5-BOT-DISK-H4b | Маршрут приёма `POST /api/myrmidon/bots/me/disk-report` и хранилище последних отчётов по контракту C4 | Наши файлы: `server/src/myrmidon/bot-containers/bot-disk-report-routes.ts`, `bot-disk-report-store.ts`, тест `bot-disk-report.myrmidon.test.ts`; строка регистрации в `server/src/app.ts` (маркер `myrmidon(1.6.5-BOT-DISK-H4b)`). Маркеров вендора нет | Проект диска ботов (BOT-DISK-H, раздел 8, H4): доска видит диск каждого бота. Требование тикета OPE-5360 | `bot-disk-report.myrmidon.test.ts` (валидный отчёт, битая схема → 400 без затирания, > 1 МиБ → 413, чужой бот → 403, два бота раздельно, фикстуры контракта) | Никогда, наше поведение. Снятие: удалить два файла и тест, строку в `app.ts` и этот фрагмент | (этот PR) |
