# Knowledge seed corpus (1.6.6 KNOWLEDGE-2.0 K-8)

> Русская версия: [knowledge-seed.ru.md](knowledge-seed.ru.md)

A new nest starts empty. The knowledge seed (`server/src/myrmidon/knowledge/seed.ts`,
release 1.6.6, OPE-5961) populates the `decisions/` and `product/` folders from a
curated, version-controlled corpus so agents open the knowledge base and find the
owner's decisions and product direction instead of a blank page. This page is the
reference for that corpus: where the content comes from, how to run the seeder,
what authority it acts with, and what its result numbers mean.

## What gets seeded

| Folder       | Items | Source |
|--------------|-------|--------|
| `decisions/` | 46    | OPE-401 owner decision registry («Реестр решений ADM (DECISIONS)»), 2026-09-26 → 2026-10-08 |
| `product/`   | 4     | OPE-2913 documents `vision-2-0` and `roadmap-v1` (owner, 29.09) |

The four product pages:

- `product/vision` — the owner's «Концепция Myrmidon 2.0» text **verbatim**
  (OPE-2913 document `vision-2-0`, Alex 29.09; not edited — the body mirrors the
  canonical fixture `server/src/myrmidon/knowledge/fixtures/vision-2-0.md`).
- `product/principles` — product principles П1–П14 (OPE-2913 `roadmap-v1`).
- `product/colony-model` — the ant-colony model → product capabilities map.
- `product/open-core` — open core + modules licensing model.

Each decision record carries the decision maker, the decision date, the owner's
verbatim quote and a source pointer back to the registry entry, so agents read
decisions as dated records rather than as a 204 KB document. Decisions are
written as `kind=wiki` items with `decided_by` / `date` / quote in the content
front-matter; product pages are `kind=note`.

Four decisions supersede an earlier one (`supersedes` chains, for example the
FORAGING variant-2 decision superseded by «включить сейчас»). The chains are
applied with `store.supersede` in a **second pass**, after both records exist,
so data order never matters; the replaced decision keeps its history and remains
available — superseded is a state, not a deletion.

## How to run it

`seedKnowledgeBase` is a **library-only export**. There is no CLI command and no
HTTP/MCP endpoint that triggers it: the only import sites are
`server/src/myrmidon/knowledge/seed.ts` and the module index
`server/src/myrmidon/knowledge/index.ts`; `routes.ts` and `mcp.ts` contain no
seed surface. To run the seed, call it from code or a script that has a database
connection:

```ts
import { seedKnowledgeBase } from "@myrmidon/server/src/myrmidon/knowledge/index.js";

const result = await seedKnowledgeBase(db, companyId, nestId);
// result: { created, skipped, superseded, errors }
```

Parameters:

- `db` — a `Db` from `@myrmidon/db` (`createDb(connectionString)`).
- `companyId` — the company (nest tree) the knowledge belongs to.
- `nestId` — the nest that owns `decisions/` and `product/`.
- `options.now?` — clock override for deterministic tests; omit in normal use.

The acceptance behaviour is pinned by the embedded-Postgres test
`server/src/myrmidon/knowledge/knowledge-seed.db.myrmidon.test.ts`.

## Publication authority

Every created item is immediately **published** (`store.publish`), not left as a
draft — the acceptance test asserts `status = "published"` and a non-null
`deliveredRevisionId` for every non-superseded item. The seeder acts as the
system actor:

```ts
export const SEED_ACTOR: KnowledgeActor = { actorType: "system", actorId: null };
```

This is the standard curator-drafts → operator-publish path collapsed into one
programmatic step: the corpus itself is reviewable in git (seed-data.ts /
seed-product.ts), so publishing happens under the merge review of that code, not
per-item in the UI. The system actor does not identify a human author — seed
items carry their real provenance in `sources` (`OPE-401` for decisions,
`OPE-2913` for product pages).

Note: running the seed is a **data** operation on a live nest. Shipping the
corpus code does not run it anywhere; nothing in 1.6.6 executes the seed against
production automatically.

## Idempotency and partial failure

The seeder is idempotent: a re-run **skips** items whose slug already exists in
the nest (a `slug_conflict` domain error from `create()` is treated as "already
there") instead of duplicating rows. The acceptance test pins this: a second run
reports `created = 0`, `skipped = first.created`, `errors = []`, and the item
count is unchanged.

There is **no corpus-wide transaction and no rollback**. Items are created one by
one, so a mid-run failure (database down, invalid data) leaves the successfully
created prefix in place. That is by design: re-running is safe — already created
slugs are skipped and the run resumes where it stopped. Supersede chains already
in their intended state count as successful skips (`superseded` is not
re-incremented; the test asserts `second.superseded = 0`).

After a run, reconcile the counters against the expected totals:

- `created + skipped` should equal **50** (46 decisions + 4 product pages) on a
  fresh nest, `skipped = 50` on a re-run.
- `superseded` should equal **4** on a fresh nest (the four `supersedes` chains),
  `0` on a re-run.
- `errors` should be empty. A `knowledge_not_found` error names a `supersedes`
  target that is missing; domain errors on supersede land in `errors` too. Any
  non-domain error aborts the run.

## What the seed does not do

- It does not create or alter users, roles, nests or companies — only knowledge
  items inside one existing nest.
- It does not import or migrate the legacy plugin wiki; that is
  [knowledge-migrate.md](knowledge-migrate.md) (K-6).
- It does not touch items with slugs outside `decisions/` and `product/`;
  pre-existing knowledge in the nest is left as is.
- It does not run on a schedule or from the UI; without a caller, the corpus
  stays in the repository only.
