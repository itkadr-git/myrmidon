---
divergence-section: 1.6.1 — BOT-DISK B: общий кэш пакетов для контейнеров ботов
---

## changelog-en

### The bot disk panel gets its reads, and the report route is wired in (1.6.5 BOT-DISK-H, parts H4b/H4d)

- New route `GET /api/myrmidon/bot-disk/reports`: the newest C4 report of every
  bot, flattened (the report itself plus `receivedAt`, the board's own receive
  time). Board staff only — a report holds the disk state of every bot, so an
  agent key gets 403 and an anonymous call 401.
- New route `GET /api/myrmidon/bot-disk/physical`: the physics of the bot
  partition (contract C5). It relays the dockergate answer
  (`GET /myrmidon/disk`, checked against `wsDiskApiResponseSchema`) and is a 503
  when the gate does not answer, instead of reporting numbers measured on the
  board's own filesystem.
- The H4b ingest route `POST /api/myrmidon/bots/me/disk-report` is now
  registered in `server/src/app.ts`. It existed since `7a8af7c1` but was mounted
  nowhere, so in a built image it answered 404 while its own test passed (the
  test mounts its own express and cannot catch a missing registration).

## changelog-ru

### Панель «Диск ботов» получает свои чтения, приём отчёта — проводку (1.6.5 BOT-DISK-H, части H4b/H4d)

- Новый маршрут `GET /api/myrmidon/bot-disk/reports`: последний отчёт C4 по
  каждому боту в плоском виде (сам отчёт плюс `receivedAt` — время приёма по
  часам доски). Только персонал доски: в отчёте лежит состояние диска всех
  ботов, поэтому ключ агента получает 403, а вызов без авторизации — 401.
- Новый маршрут `GET /api/myrmidon/bot-disk/physical`: физика раздела ботов
  (контракт C5). Отдаёт ответ dockergate (`GET /myrmidon/disk`, проверенный
  схемой `wsDiskApiResponseSchema`); если gate не отвечает — 503, вместо цифр,
  измеренных на файловой системе самой доски.
- Приём `POST /api/myrmidon/bots/me/disk-report` (H4b) теперь зарегистрирован в
  `server/src/app.ts`. Маршрут существует с `7a8af7c1`, но не был смонтирован
  нигде, поэтому в собранном образе отвечал 404, а его собственный тест этого
  не видел: тест поднимает свой express и пропущенную регистрацию поймать не
  может.

## divergence

| 1.6.5-BOT-DISK-H4b/H4d | Чтения панели «Диск ботов» (C4 последний отчёт, C5 физика раздела) и проводка приёма H4b в приложение | Наши файлы: `server/src/myrmidon/bot-containers/bot-disk-reads-routes.ts`, тест `bot-disk-reads.myrmidon.test.ts`; строки регистрации в `server/src/app.ts` (маркеры `myrmidon(1.6.5-BOT-DISK-H4b)`, `myrmidon(1.6.5-BOT-DISK-H4d)`). Маркеров вендора нет | Панель «Диск ботов» читает ровно эти два пути (`ui/src/components/myrmidon/botDiskLifecycleApi.ts`), а приём C4 из #766 в образе не был смонтирован и отвечал 404 | `bot-disk-reads.myrmidon.test.ts` (форма плоского ответа, приём → чтение, пустой склад, 403/401, 503 при молчащем dockergate, фикстуры контракта) | Никогда, наше поведение. Снятие: удалить `bot-disk-reads-routes.ts`, его тест, две строки в `app.ts` и этот фрагмент | (этот PR) |