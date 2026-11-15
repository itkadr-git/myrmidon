# Interactive readdress dry-run

> Русская версия: [Readdress-report.ru](Readdress-report.ru)


Run the report against the target database before any readdress operation:

```sh
DATABASE_URL="$DATABASE_URL" pnpm exec tsx scripts/myrmidon/interactions/readdress-report.ts --format=json
```

The script opens a read-only PostgreSQL transaction and does not modify interaction rows. `DATABASE_URL` must point at the intended environment. `--format` accepts `json` (default) or `csv`. Use `--format=csv` when a spreadsheet is more useful. Exit status `0` means the report was written to stdout, `1` means a database/query error, and `2` means `DATABASE_URL` is missing or the format is invalid.
