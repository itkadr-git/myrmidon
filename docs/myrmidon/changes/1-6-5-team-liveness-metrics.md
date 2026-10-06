---
divergence-section: Трек 2 — ядро побудок и прогонов
settings-section: Track 2 — wake and run core
---

## changelog-en

### Team liveness: a 24-hour health card (TEAM-LIVENESS-METRICS)

The company settings (health) page gains a "Team liveness" card with the four
counters of the last day for the selected company: **auto-resumes** (agents the
board brought back out of `error` by itself), **resumes given up** (attempts
ran out, so a human has to look), **wakes** (wake requests the board created)
and **stalled runs** (runs progress-based run liveness interrupted).

Nothing new is stored: the numbers are read from the rows the three behaviours
already write — the activity log for auto-resume, `agent_wakeup_requests` for
the wakes, and the run error code for the stalls. `GET
/api/myrmidon/team-liveness/metrics?companyId=…` serves them to the board; the
route is company-scoped, the same access rule the fleet console uses.

To be read: a nonzero "stalled runs" is the sweep doing its job, not a broken
server; a nonzero "resumes given up" is the one number that asks for a human.

## changelog-ru

### Команда жива: карточка здоровья за 24 часа (TEAM-LIVENESS-METRICS)

На странице настроек компании (health) появилась карточка «Team liveness» с
четырьмя счётчиками за последние сутки по выбранной компании:
**auto-resumes** — агенты, которых доска сама вернула из `error`; **resumes
given up** — попытки кончились, нужен человек; **wakes** — побудки, которые
создала доска; **stalled runs** — прогоны, которые прервал прогресс-лайвнес.

Ничего нового не хранится: числа читаются из строк, которые три поведения уже
пишут — журнал активности для авто-резюма, `agent_wakeup_requests` для побудок,
код ошибки прогона для застоев. Отдаёт их доске `GET
/api/myrmidon/team-liveness/metrics?companyId=…`; маршрут привязан к компании,
то же правило доступа, что у консоли флота.

Как читать: ненулевые «stalled runs» — это работающий свип, а не сломанный
сервер; ненулевые «resumes given up» — единственное число, которое просит
человека.

## divergence

| ID | Что меняем | Файлы вендора | Причина | Тест-сторож | Как снимать | PR |
| --- | --- | --- | --- | --- | --- | --- |
| TEAM-LIVENESS-METRICS | Счётчики за 24 часа для health-карточки: читаем журнал активности, заявки на побудку и код ошибки прогона; `GET /api/myrmidon/team-liveness/metrics` | `server/src/myrmidon/team-liveness/metrics.ts`, `server/src/myrmidon/team-liveness/routes.ts`, `ui/src/components/myrmidon/TeamLivenessHealthCard.tsx`, `ui/src/pages/CompanySettings.tsx` | Доска сама держит агентов в работе (авто-резюм, прогресс-лайвнес, побудка по готовой задаче) — оператору нужен видимый итог за сутки на health-странице, иначе «команда жива» остаётся непроверяемым утверждением | `server/src/myrmidon/team-liveness/metrics.db.myrmidon.test.ts` (окно и компания реально связывают: тихие сутки — нули, чужая компания не протекает), `ui/src/components/myrmidon/TeamLivenessHealthCard.myrmidon.test.tsx` (числа и состояния чтения) | Удалить карточку со страницы и маршрут; счётчики в C/D остаются, но никем не потребляются | — |