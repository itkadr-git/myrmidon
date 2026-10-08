# OPE-5575: drizzle snapshot chain repair and check

`meta/0305_snapshot.json` carried the same `id` as 0304 and a `prevId` pointing at itself, so
`drizzle-kit generate` stopped with "pointing to a parent snapshot ... which is a collision".

- 0305 gets a new unique `id`; 0306 `prevId` follows it. Migrations and the journal are untouched,
  so the runner is not affected.
- `check:migrations` now also runs `src/check-migration-snapshots.ts`: unique ids, no self-reference,
  no cycles, and from 0296 on every snapshot names the preceding snapshot as its parent. Older
  snapshots with dangling parents (0027, 0039, 0077, 0091, 0292, 0295) are tolerated.
- 0313 is repaired separately by PR #902; this check stays red on rel until that lands.
