---
divergence-section: Трек 2 — ядро побудок и прогонов
settings-section: Track 2 — wake and run core
---

## changelog-en

### Owner decision cards now expire on a TTL and close themselves (1.6.5-F21-B)

- `server/src/myrmidon/owner-reply/ttl-sweep.ts` — a scheduler-tick sweep:
  a pending owner `request_confirmation` card older than
  `MYRMIDON_OWNER_CARD_TTL_MS` (72 h) is closed in the first pass. A card with
  `payload.silenceMeansRecommended: true` outside the guarded classes
  (`money`, `external_world`, `deploy`) is resolved by its recommended option;
  every other overdue card goes `expired` with the "expired without an
  answer" comment on the task and ONE wake of the author with the reason
  `interaction_expired` (the `agentWakeupRequests` idempotency key limits the
  wake to one per card, repeat passes wake nobody). The sweep derives the
  delivery metadata (`sentTo`/`sentAt`/`answeredAt`) from the card itself and
  the existing owner-message comments, and folds it into the card payload.
- `server/src/myrmidon/owner-reply/attention.ts` — the attention-feed card
  «owner cards pending: N (older than 3 days: M)», computed live from the
  same interaction rows; a new `owner_pending_card` source kind.
- Tests: `ttl-sweep.myrmidon.test.ts` (the pure classification, TTL gate,
  decision-class boundary, payload pack, env parsing) and
  `ttl-sweep-sweep.myrmidon.test.ts` (embedded PG: overdue cards closed in
  one pass, exactly one wake, silence resolution, the money-class guard, the
  concurrency compare-and-set).

## changelog-ru

### TTL карточек владельца, резолв по молчанию и attention-карточка (1.6.5-F21-B)

- `server/src/myrmidon/owner-reply/ttl-sweep.ts` — проход на тике
  планировщика: ожидающая `request_confirmation`-карточка владельца старше
  `MYRMIDON_OWNER_CARD_TTL_MS` (72 ч) закрывается первым же проходом. Карточка
  с `payload.silenceMeansRecommended: true` вне защищённых классов (`money`,
  `external_world`, `deploy`) резолвится по рекомендованной опции; остальные
  просроченные уходят в `expired` с комментарием «истекла без ответа» на
  задаче и ОДНОЙ побудкой автора с причиной `interaction_expired`
  (идемпотентность по ключу `agentWakeupRequests`, повторный проход никого не
  будит). Проход выводит delivery-метаданные (`sentTo`/`sentAt`/`answeredAt`)
  из самой карточки и существующих комментариев owner-сообщений и складывает
  их в payload карточки.
- `server/src/myrmidon/owner-reply/attention.ts` — карточка ленты внимания
  «карточек владельца pending: N (старше 3 дней: M)», вычисляется на лету из
  тех же строк; новый sourceKind `owner_pending_card`.
- Тесты: `ttl-sweep.myrmidon.test.ts` (чистая классификация, TTL-гейт,
  граница классов, сборка payload, разбор env) и
  `ttl-sweep-sweep.myrmidon.test.ts` (embedded PG: все просроченные
  закрываются первым проходом, ровно одна побудка, резолв по молчанию, страж
  класса money, гонка закрытия с ответом).

## divergence

| 1.6.5-F21-B | Ожидающая карточка владельца (`request_confirmation`, адресат-владелец по `isOwnerDecisionAudience`) старше TTL закрывается проходом подметания: `silenceMeansRecommended` вне защищённых классов резолвится по рекомендованной опции, остальное — `expired` с системным комментарием и одной побудкой автора `interaction_expired` (лимитер — ключ `agentWakeupRequests`). Delivery-метаданные карточки пишутся в её payload при закрытии. Наблюдаемость: карточка ленты внимания «карточек владельца pending: N (старше 3 дней: M)», вычисляемая на лету | Вендор (маркер `myrmidon(1.6.5-F21-B)`): `packages/shared/src/types/attention.ts` (одна строка sourceKind), `server/src/services/attention.ts` (импорт, sourceKind и ранг, блок-генератор), `server/src/services/decision-queues.ts` (один кейс источника), `server/src/index.ts` (импорт, построение, две строки вызова в тиках); + `server/src/myrmidon/owner-reply/{index,settings,ttl-sweep,attention}.ts` | F-21: старые карточки владельца без ответа висели вечно (часть A даёт закрытие ответом, часть B — по TTL) | `server/src/myrmidon/owner-reply/ttl-sweep.myrmidon.test.ts`, `server/src/myrmidon/owner-reply/ttl-sweep-sweep.myrmidon.test.ts` | Когда вендор научится TTL и резолву по молчанию для карточек владельца: удалить куски с маркером `myrmidon(1.6.5-F21-B)`, модуль `owner-reply` (общий с частью A — координировать) и тесты | (этот PR) |

## settings-en

| `MYRMIDON_OWNER_CARD_TTL_MS` | 1.6.5-F21-B | `259200000` (72 h) | how long an owner `request_confirmation` card may stay unanswered before the TTL sweep closes it (resolve-by-silence or expire) | set to a very large value to effectively disable the expiry |
| `MYRMIDON_OWNER_CARD_SWEEP_INTERVAL_SEC` | 1.6.5-F21-B | `300` | how often the owner-card TTL sweep pass runs on the heartbeat scheduler tick | set to a very large value to effectively pause the sweep |
| `MYRMIDON_OWNER_CARD_SWEEP_WAKE_BUDGET` | 1.6.5-F21-B | `20` | the most author wakes one pass may send; the rest wait for the next pass | set to `0` to expire silently without waking authors |

## settings-ru

| `MYRMIDON_OWNER_CARD_TTL_MS` | 1.6.5-F21-B | `259200000` (72 ч) | сколько карточка `request_confirmation` владельца может оставаться без ответа до закрытия sweep'ом (резолв по молчанию или просрочка) | поставить очень большое значение, чтобы фактически выключить просрочку |
| `MYRMIDON_OWNER_CARD_SWEEP_INTERVAL_SEC` | 1.6.5-F21-B | `300` | как часто запускается TTL-sweep карточек владельца на тике планировщика | поставить очень большое значение, чтобы фактически приостановить sweep |
| `MYRMIDON_OWNER_CARD_SWEEP_WAKE_BUDGET` | 1.6.5-F21-B | `20` | сколько побудок авторов максимум может сделать один проход sweep'а | поставить `0`, чтобы просрочивать без побудок авторов |
