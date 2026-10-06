# Database backup retention

> Russian version: [backup-retention.ru.md](backup-retention.ru.md)

The board backs up its database automatically (roughly every hour by default)
into gzipped dumps named `<prefix>-<timestamp>.sql.gz` in the backup
directory, and prunes old copies after every run. The retention policy — how
long copies are kept — is an instance setting, not an environment variable:
change it on the Instance → General page («Backup retention») and it takes
effect on the next backup run, without a server restart. It is also readable
and writable through `GET`/`PATCH /api/instance/settings/general` as the
`backupRetention` object.

## Tiered retention (the default)

With no mode option on, each backup run prunes old copies along three tiers,
set by the `dailyDays` / `weeklyWeeks` / `monthlyMonths` presets in the UI
(3/7/14 days, 1/2/4 weeks, 1/3/6 months; default 7 / 4 / 1):

- Daily tier: all backups of the last `dailyDays` days are kept.
- Weekly tier: the newest backup of each calendar week (ISO 8601) is kept for
  `weeklyWeeks` weeks.
- Monthly tier: the newest backup of each calendar month is kept for
  `monthlyMonths` months.

## Keep only the latest backup (1.6.5)

The «Keep only the latest backup» option next to the presets switches the
policy to keep-last mode (`backupRetention.keepLastOnly: true`). While the
mode is on, a backup run ignores the tier presets: after the new dump is
written, the server verifies it and only then deletes every previous
`<prefix>-*.sql.gz` and `<prefix>-*.sql` file in the backup directory.

Picking any daily/weekly/monthly preset turns the mode back off
(`keepLastOnly: false`), so the two ways of configuring retention never
conflict. While the mode is on, the page shows a hint under the presets that
they are ignored.

The contract is additive: settings payloads written before 1.6.5 parse
unchanged, and an absent flag keeps the tiered behavior.

## Verification before deletion

In keep-last mode the new dump is stream-verified before any old copy is
deleted: a full gunzip pass (a corrupt archive fails here) plus a check that
the decompressed tail carries a dump completion marker — the closing `COMMIT;`
of the JavaScript logical dump or the `-- PostgreSQL database dump complete`
trailer that `pg_dump --format=plain` ends with. The check keeps only a 64 KiB
tail buffer, so multi-gigabyte dumps verify in streaming mode, without
materializing the whole file. Both backup engines (the `pg_dump` path and the
JavaScript logical-dump path) verify and prune identically.

A new dump that fails verification is deleted on the spot, all previous
backups are kept untouched, and the run fails with the reason
(`Backup verification failed for <file>: <reason>; previous backups were
kept`): the mode can never trade a good old backup for a bad new one. The
failure is not retried on the other engine — it is reported as
`BackupVerificationError` and fails the run loudly. Disk space is not freed
until the next successful run; that trade-off is what the safety note under
the option in the UI states.

## Orphaned `.sql` files

A dump is first written as a plain `.sql` file and then gzipped to `.sql.gz`,
so an interrupted run (a crash, a kill) strands an unfinished `.sql` in the
backup directory. Since 1.6.5 every pruning pass — in both retention modes — first
removes such orphaned `.sql` files older than one hour (constant
`BACKUP_ORPHAN_SQL_MAX_AGE_MS`). A live run's own in-progress `.sql` is never
touched: the cutoff is strictly older than one hour and the writer keeps its
mtime fresh. Removed orphans count into the run's `prunedCount`, same as
retention deletions.
