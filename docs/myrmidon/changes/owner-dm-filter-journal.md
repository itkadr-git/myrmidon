---
divergence-section: Трек 4 — чаты и навыки
---

## changelog-en

### Owner-DM delivery journal (1.6.5 OWNER-DM-FILTER, part C)

- New instance-admin endpoint `GET /api/myrmidon/owner-delivery/publications?since=<iso>`
  lists chat publications that reached owner Telegram DM conversations in the
  window, each labeled `owner_decision` or `operational` with a machine-readable
  reason. The classification derives from the card's interaction row
  (`effectiveResolverPolicy` / `addresseeUserId` against the task owner), joined
  through `payload->>'interactionId'` — nothing new is stored and no migration
  ships.
- This is the observable surface behind the acceptance criterion "no operational
  cards in the owner's DM within a day of rollout": after the part-A filter
  ships, an `operational` entry can only come from a publication row created
  before the rollout; a fresh one is the alarm.

## changelog-ru

### Журнал доставки в ЛС владельца (1.6.5 OWNER-DM-FILTER, часть C)

- Новый маршрут instance-admin `GET /api/myrmidon/owner-delivery/publications?since=<iso>`
  отдаёт публикации, ушедшие в Telegram-ЛС владельца за период, каждую — с
  классом `owner_decision` или `operational` и машиночитаемой причиной. Класс
  выводится из полей interaction карточки (`effectiveResolverPolicy` /
  `addresseeUserId` против владельца задачи) через join по
  `payload->>'interactionId'` — ничего нового не хранится, миграции нет.
- Это наблюдаемая поверхность критерия «ни одной операционной карточки в ЛС
  владельца за сутки после выката»: после выката фильтра части A запись
  `operational` может появиться только от публикации, созданной до выката;
  свежая такая запись — сигнал тревоги.

## divergence

| 1.6.5-OWNER-DM-FILTER-C | Новый read-only маршрут журнала доставки owner-DM: импорт и `api.use(ownerDeliveryRoutes(db))` | `server/src/app.ts` (2 строки-вызова) | Доске нужен проверяемый журнал публикаций в ЛС владельца без дублирования полей interaction в БД | `server/src/__tests__/owner-delivery-publications.myrmidon.test.ts` | Удалить строки импорта и монтирования; модуль `server/src/myrmidon/owner-delivery/{classify,routes}.ts` уходит вместе | (этот PR) |
