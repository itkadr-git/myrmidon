# Interactive readdress dry-run

Run the report against the target database before any readdress operation:

```sh
DATABASE_URL="$DATABASE_URL" pnpm exec tsx scripts/myrmidon/interactions/readdress-report.ts --format=json
```

The script opens a read-only PostgreSQL transaction and does not modify interaction rows. `DATABASE_URL` must point at the intended environment. `--format` accepts `json` (default) or `csv`. Use `--format=csv` when a spreadsheet is more useful. Exit status `0` means the report was written to stdout, `1` means a database/query error, and `2` means `DATABASE_URL` is missing or the format is invalid.

# Сухой прогон переадресации интеракций

Перед любым изменением адресатов сформируйте отчёт для нужной базы:

```sh
DATABASE_URL="$DATABASE_URL" pnpm exec tsx scripts/myrmidon/interactions/readdress-report.ts --format=json
DATABASE_URL="$DATABASE_URL" pnpm exec tsx scripts/myrmidon/interactions/readdress-report.ts --format=csv
```

Скрипт открывает read-only транзакцию PostgreSQL и не меняет строки интеракций. `DATABASE_URL` должен указывать на нужное окружение. `--format` принимает `json` (по умолчанию) или `csv`. Код завершения `0` означает, что отчёт выведен в stdout; `1` — ошибка БД/запроса; `2` — отсутствует `DATABASE_URL` или задан неверный формат. Команда и поля отчёта не зависят от языка.
