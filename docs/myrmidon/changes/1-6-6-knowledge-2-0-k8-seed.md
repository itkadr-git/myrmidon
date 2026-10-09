---
divergence-section: KNOWLEDGE-2.0 — единый модуль знаний
---

## changelog-en

### Knowledge base seed: decisions/ and product/ (KNOWLEDGE-2.0 K-8)

- New seed corpus `server/src/myrmidon/knowledge/seed-data.ts`: 45 owner
  decisions imported from the OPE-401 registry ("Реестр решений ADM"), one
  knowledge item per decision with `decided_by`, ISO date, the owner's
  verbatim quote, and a `sources` pointer back to the registry entry. Each
  decision lives in the `decisions/` folder as a dated record, so agents read
  decisions as individual entries instead of a 204 KB document (arch §6 K-8).
- New seed corpus `server/src/myrmidon/knowledge/seed-product.ts`: the four
  `product/` pages — `product/vision` (Alex's "Концепция Myrmidon 2.0" text
  verbatim, per the dont_revise_owners_existing_texts memory),
  `product/principles` (principles P1–P14), `product/colony-model` (the
  ant-colony model → product capabilities map), and `product/open-core`
  (open core MIT + closed modules licensing model).
- New seeder `seedKnowledgeBase(db, companyId, nestId)` in
  `server/src/myrmidon/knowledge/seed.ts`, exported from the module barrel.
  Idempotent: existing slugs are skipped. Supersede chains are applied via
  `store.supersede` in a second pass, so cancelled decisions (e.g. FORAGING
  "вариант 2" 03.10 → "включить сейчас" 03.10) link to their replacement and
  keep their history.
- Tests: `knowledge-seed.db.myrmidon.test.ts` (3 tests over embedded Postgres)
  asserting ≥40 decisions with decided_by/date/quote, 4 product pages, the
  FORAGING supersede chain, and idempotency on re-run.

## changelog-ru

### Посев базы знаний: decisions/ и product/ (KNOWLEDGE-2.0 K-8)

- Новый корпус `server/src/myrmidon/knowledge/seed-data.ts`: 45 решений
  владельца из реестра OPE-401 («Реестр решений ADM»), по одной записи на
  решение с `decided_by`, датой ISO, дословной цитатой владельца и ссылкой
  `sources` на запись реестра. Каждое решение лежит в папке `decisions/` как
  запись с датой, чтобы агенты читали решения по одной записи, а не как
  документ на 204 КБ (архитектура §6 K-8).
- Новый корпус `server/src/myrmidon/knowledge/seed-product.ts`: четыре
  страницы `product/` — `product/vision` (текст Alex «Концепция Myrmidon
  2.0» дословно, по памяти dont_revise_owners_existing_texts),
  `product/principles` (принципы П1–П14), `product/colony-model` (модель
  колонии → возможности продукта) и `product/open-core` (открытое ядро MIT +
  закрытые модули).
- Новый сидер `seedKnowledgeBase(db, companyId, nestId)` в
  `server/src/myrmidon/knowledge/seed.ts`, экспортируется из barrel модуля.
  Идемпотентен: существующие slug пропускаются. Цепочки `supersedes`
  применяются через `store.supersede` вторым проходом — отменённые решения
  (например, FORAGING «вариант 2» 03.10 → «включить сейчас» 03.10)
  ссылаются на замену и сохраняют историю.
- Тесты: `knowledge-seed.db.myrmidon.test.ts` (3 теста на встроенном
  Postgres) проверяют ≥40 решений с decided_by/датой/цитатой, 4 страницы
  product/, цепочку supersedes FORAGING и идемпотентность повторного прогона.
