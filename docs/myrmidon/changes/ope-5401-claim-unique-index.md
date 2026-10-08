---
divergence-section: 1.6 — очереди задач по ролям с leased claims (SWARM-CLAIM, часть A — ядро)
---

## changelog-en

### Active issue claims are unique at the database (1.6.5 SWARM-CLAIM-UNIQUE-INDEX)

- The swarm-claim capture path checked the live lease with a SELECT and then
  INSERTed, so two board processes racing for the same issue could both pass
  the check and both take the task — the same issue ran twice at once, and the
  lost racer on the older single-writer path surfaced a raw unique-violation
  error instead of a busy answer.
- Migration `packages/db/src/migrations/0360_issue_claims_active_unique.sql`
  first folds the historical duplicates: for every issue with more than one
  live claim (`released_at IS NULL`) the earliest row by `claimed_at` (ties
  broken by `id`) stays live and the rest get `released_at` with
  `release_reason = 'migration_dedup_0360'`. Then it builds the partial unique
  index `issue_claims_issue_active_uq` on `(issue_id) WHERE released_at IS
  NULL` — one live claim per issue, enforced by PostgreSQL, not by application
  order. `IF NOT EXISTS` and the dedup predicate exclude already-released
  rows, so re-applying the migration on a database that already moved is a
  no-op.
- The capture store (`server/src/myrmidon/swarm-claim/store.ts`) now maps a
  23505 from the claim INSERT to the same `null` the pre-check returns —
  «занято», not a 500. Non-uniqueness errors still propagate unchanged.
- Default behavior does not change: the claim API contract, the lease fields,
  the sweep and the supervisor rebalance are untouched; the index only closes
  the window where two winners were possible.
- Guards: `packages/db/src/issue-claims-active-unique-migration.myrmidon.test.ts`
  (static: migration file, journal entry, 0360 snapshot index; embedded
  Postgres: dedup keeps the earliest live claim and releases the rest, the
  index is partial and unique, a second live INSERT for the same issue raises
  23505, released rows do not collide, re-application is idempotent) and
  `server/src/myrmidon/swarm-claim/claim-race.myrmidon.test.ts` (two parallel
  claims of one issue on embedded Postgres — exactly one succeeds, the other
  gets the busy answer, never an exception; the mapped 23505 seam and its
  narrowness are pinned with fakes).

## changelog-ru

### Живой клейм задачи уникален на уровне базы (1.6.5 SWARM-CLAIM-UNIQUE-INDEX)

- Путь захвата swarm-claim проверял живой лиз SELECT'ом и затем вставлял
  строку, поэтому два процесса доски в гонке за одну задачу проходили
  проверку вдвоём и забирали её вдвоём — одна задача запускалась дважды
  одновременно, а проигравший на старом однопроцессном пути получал наружу
  сырую ошибку уникальности вместо ответа «занято».
- Миграция `packages/db/src/migrations/0360_issue_claims_active_unique.sql`
  сначала разбирает исторические дубли: для каждой задачи с несколькими
  живыми клеймами (`released_at IS NULL`) самая ранняя по `claimed_at`
  (при равенстве — по `id`) остаётся живой, остальные освобождаются с
  `release_reason = 'migration_dedup_0360'`. Затем строится частичный
  уникальный индекс `issue_claims_issue_active_uq` по `(issue_id) WHERE
  released_at IS NULL` — один живой клейм на задачу гарантирует PostgreSQL,
  а не порядок кода. `IF NOT EXISTS` и предикат дедупа не трогают
  освобождённые строки, повторное применение миграции на уже разобранной
  базе — пустой операция.
- Store захвата (`server/src/myrmidon/swarm-claim/store.ts`) теперь
  превращает 23505 из вставки клейма в тот же `null`, что возвращает
  предпроверка — «занято», а не 500. Ошибки не-уникальности пробрасываются
  как раньше.
- Поведение по умолчанию не меняется: контракт API клейма, поля лиза, свип
  и ребаланс супервизора те же; индекс только закрывает окно, в котором
  возможных победителей было двое.
- Сторожа: `packages/db/src/issue-claims-active-unique-migration.myrmidon.test.ts`
  (статика: файл миграции, запись журнала, индекс в снапшоте 0360; embedded
  Postgres: дедуп оставляет самый ранний живой клейм и освобождает
  остальные, индекс частичный и уникальный, вторая живая вставка на ту же
  задачу даёт 23505, освобождённые строки не конфликтуют, повторное
  применение идемпотентно) и `server/src/myrmidon/swarm-claim/claim-race.myrmidon.test.ts`
  (два параллельных клейма одной задачи на embedded Postgres — ровно один
  успех, второй ответ «занято» и никогда исключение; шов 23505 и его узость
  закреплены заглушками).

## divergence

| SWARM-CLAIM-UNIQUE-INDEX | Частичный уникальный индекс `issue_claims_issue_active_uq` на вендорской таблице `issue_claims` (миграция 0360: сначала дедуп живых дублей — самый ранний клейм на задачу остаётся, остальные освобождаются с `release_reason = 'migration_dedup_0360'`, затем `CREATE UNIQUE INDEX ... (issue_id) WHERE released_at IS NULL`). В вендорном пути захвата `claimForCheckout` (hook в `server/src/services/heartbeat.ts` → `insertClaim`) вставка обёрнута в `.catch`: 23505 (в т.ч. завёрнутый drizzle в `error.cause`) трактуется как «занято» — `null`, тот же контракт, что у предпроверки; прочие ошибки пробрасываются | `packages/db/src/schema/issue_claims.ts` (объявление `uniqueIndex(...).where(sql\`released_at is null\`)`, метка `myrmidon(SWARM-CLAIM-UNIQUE-INDEX)`), миграция `0360_issue_claims_active_unique.sql` + meta (journal 360, снапшот 0360), `server/src/myrmidon/swarm-claim/store.ts` (`.catch(isUniqueViolation → null)` в `insertClaim`, импорт `isUniqueViolation` из `../../db-errors.js`) | Гонка swarm claim при нескольких процессах доски (OPE-5394 ч.4): предпроверка SELECT+INSERT допускала двух победителей на одну задачу; 1.6.5 (OPE-5401 ч.A) требует закрывать гонку на базе, 23505 наружу — это 500 вместо «занято» | `packages/db/src/issue-claims-active-unique-migration.myrmidon.test.ts` (дедуп, форма индекса, 23505 на второй живой вставке, идемпотентность повторного применения, статика journal/snapshot) + `server/src/myrmidon/swarm-claim/claim-race.myrmidon.test.ts` (два параллельных claim — ровно один успех, второй null; маппинг 23505; не-уникальные ошибки идут наружу) | Никогда, наше поведение; индекс односторонний (CONVENTIONS §8), таблица наша (1.6-SWARM-A). Снять: только вместе с удалением модуля swarm-claim | (этот PR) |
