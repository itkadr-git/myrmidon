---
divergence-section: Трек 5 — эксплуатация
---

## changelog-en

### CLI: `myrmidon:migrate` moves a Paperclip v2026.916.1 instance into a clean Myrmidon target (MIGRATE-A)

- New command `paperclipai myrmidon:migrate`: `--dry-run` prints a full JSON inventory (tables, row counts, content digests, secret carriers, file manifest, exclusions) and writes nothing; without `--dry-run` it transfers the database, the storage files and the secrets.
- Source is a PostgreSQL URL (read-only snapshot) or a plain `pg_dump` file restored into an empty scratch database. The source is supported only when its applied migration hashes equal the pinned vendor chain of release v2026.916.1 exactly; any other history is rejected before the target is touched.
- Secrets stored as `local_encrypted_v1` envelopes anywhere in a JSON column are decrypted with the source key and encrypted with the target key through the existing provider; the run fails closed on a wrong key, on a carrier in a text column, and verifies the target decryption (the old key must not open the target).
- The target must be an empty dedicated database and an empty directory. A lock and a durable journal in `--state-dir` make a rerun idempotent and a failed run resumable without duplicates; `--rollback` removes only what the run created.
- The server package now exports `secrets/local-encrypted-provider` so the CLI reuses the provider instead of copying the cipher.

## changelog-ru

### CLI: `myrmidon:migrate` переносит инстанс Paperclip v2026.916.1 в чистый Myrmidon (MIGRATE-A)

- Новая команда `paperclipai myrmidon:migrate`: `--dry-run` печатает полный JSON-инвентарь (таблицы, число строк, дайджесты содержимого, носители секретов, манифест файлов, исключения) и ничего не пишет; без `--dry-run` переносит базу, файлы хранилища и секреты.
- Источник — URL PostgreSQL (снимок только для чтения) или plain-файл `pg_dump`, разворачиваемый в пустую временную базу. Источник поддержан, только если хэши применённых миграций в точности равны закреплённой цепочке вендорского релиза v2026.916.1; любая другая история отвергается до обращения к целевой базе.
- Секреты в виде конвертов `local_encrypted_v1` в любом JSON-столбце расшифровываются ключом источника и шифруются ключом цели через существующий провайдер; неверный ключ и носитель в текстовом столбце останавливают перенос, расшифровка в цели проверяется (старый ключ цель не открывает).
- Цель — пустая выделенная база и пустой каталог. Блокировка и журнал в `--state-dir` делают повтор идемпотентным, а прерванный перенос — продолжаемым без дублей; `--rollback` убирает только созданное запуском.
- Пакет server теперь экспортирует `secrets/local-encrypted-provider`, чтобы CLI использовал провайдер, а не копию шифра.

## divergence

| MIGRATE-A | Команда переноса Paperclip → Myrmidon (`myrmidon:migrate`): проверка цепочки хэшей, снимок источника, перенос БД/файлов/секретов, журнал, откат; в `server/package.json` добавлен подпуть экспорта `./secrets/local-encrypted-provider`, в `packages/db` — чтение цепочки миграций `listMigrationChain` | `server/package.json` (exports), `packages/db/src/{client,index}.ts` (+`listMigrationChain`); + `cli/src/commands/myrmidon-migrate*.ts`, `cli/src/index.ts` | Переход пользователей Paperclip на Myrmidon без потери данных и секретов | `cli/src/__tests__/myrmidon-migrate.test.ts` | При переносе: оставить подпуть экспорта server, остальное — наше | — |
