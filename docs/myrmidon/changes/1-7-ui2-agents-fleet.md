---
divergence-section: 1.7 — UI 2.0
---

## changelog-en

### UI 2.0 agents fleet screen (OPE-8576)

- Added the company-scoped `agents` route with a scrollable `reportsTo` tree, canonical agent statuses, bounded live-run data, empty state, and direct agent-card links.

## changelog-ru

### Экран флота агентов UI 2.0 (OPE-8576)

- Добавлен маршрут `agents` с прокручиваемым деревом `reportsTo`, каноническими статусами агентов, ограниченным запросом активных прогонов, пустым состоянием и переходом в карточку агента.

## divergence

| OPE-8576 | Экран флота агентов UI 2.0 на маршруте `agents`: дерево компании по `reportsTo`, статусы `active`/`idle` → idle, `running`, `paused`, `error`, ограниченный список активных прогонов и локализованные состояния | Вендорский список агентов и UI 2.0 shell navigation | Нужна операторская видимость работающих агентов без загрузки всей истории heartbeat; поведение живёт в форке до появления вендорского эквивалента | `ui/src/ui2/tests/ui2Screens.myrmidon.test.ts`, route/shell tests, CI affected tests | Когда вендор добавит эквивалентный экран флота и дерево агентов, сверить API/статусы и снять fork route, navigation, locale, screen, tests и docs | #1506 |
