## changelog-en

### Drizzle snapshot chain repaired and checked (1.6.5 OPE-5575)

- `meta/0305_snapshot.json` carried the same `id` as 0304 and a `prevId` pointing at itself, so `drizzle-kit generate` stopped with a parent-snapshot collision. 0305 gets a new unique `id`; 0306 `prevId` follows it. Migrations and the journal are untouched, so the runner is not affected.
- `check:migrations` now also runs `src/check-migration-snapshots.ts`: unique ids, no self-reference, no cycles, and from 0296 on every snapshot names the preceding snapshot as its parent. Older snapshots with dangling parents (0027, 0039, 0077, 0091, 0292, 0295) are tolerated.

## changelog-ru

### Цепочка снимков drizzle починена и проверяется (1.6.5 OPE-5575)

- У `meta/0305_snapshot.json` был тот же `id`, что у 0304, а `prevId` указывал сам на себя, поэтому `drizzle-kit generate` останавливался на коллизии родительского снимка. 0305 получил новый уникальный `id`, `prevId` у 0306 перецеплен на него. Миграции и журнал не тронуты, запуск миграций не меняется.
- `check:migrations` теперь запускает и `src/check-migration-snapshots.ts`: уникальные id, без ссылки на себя, без циклов, а начиная с 0296 каждый снимок указывает родителем предыдущий. Старые снимки с висячим родителем (0027, 0039, 0077, 0091, 0292, 0295) допускаются.
