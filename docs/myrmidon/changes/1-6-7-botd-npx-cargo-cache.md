---
settings-section: Track 3 — tool gateway and Hermes adapter
---

## changelog-en

### A bot's npx and cargo caches stay under a byte quota (OPE-12110)

One bot grew `hermes/.npm/_npx` by 2.2 GB in 45 minutes (npx fetched a whole vendor package with all
its binaries), and a Rust `target/` in a task working copy reached 2.4 GB. botd now bounds both:

- `hermes/.npm/_npx`: entries older than 24 h are removed, and when the rest weighs more than the
  quota (512 MiB per bot) the entries written longest ago go first, until it fits.
- `hermes/.cache/cargo-target`, the per-bot `CARGO_TARGET_DIR` the bot image already sets (outside
  every task working copy): quota 2 GiB per bot, whole profile dirs (`debug`, `release`, a target
  triple) removed least recently written first. A bot that never builds Rust has no such directory
  and nothing creates it.

Both passes work on whole entries, never remove a path a process holds open, and never touch an entry
written in the last 15 minutes (an install or a build may still be going), so a quota can stay
exceeded for one pass. Each eviction is a line in the botd log. The quotas are set with
`MYRMIDON_BOTD_NPM_NPX_QUOTA_BYTES` and `MYRMIDON_BOTD_CARGO_TARGET_QUOTA_BYTES` on the botd process.

## changelog-ru

### Кэши npx и cargo бота держатся в пределах квоты в байтах (OPE-12110)

У одного бота `hermes/.npm/_npx` вырос на 2,2 ГБ за 45 минут (npx скачал целиком вендорский пакет со
всеми бинарями), а `target/` Rust в рабочей копии задачи дошёл до 2,4 ГБ. Теперь botd ограничивает оба:

- `hermes/.npm/_npx`: записи старше 24 часов удаляются, а если остальные весят больше квоты
  (512 МиБ на бота), первыми уходят записи, в которые писали давнее всего, пока всё не уложится.
- `hermes/.cache/cargo-target` — каталог `CARGO_TARGET_DIR` бота, который образ уже задаёт (вне любой
  рабочей копии задачи): квота 2 ГиБ на бота, целиком удаляются каталоги профилей (`debug`, `release`,
  целевая тройка), к которым писали давнее всего. У бота, который не собирает Rust, такого каталога нет,
  и ничто его не создаёт.

Оба прохода работают с целыми записями, не трогают путь, открытый процессом, и не трогают запись, в которую
писали последние 15 минут (установка или сборка могут ещё идти), поэтому квота может оставаться
превышенной на один проход. Каждое вытеснение — строка в журнале botd. Квоты задаются переменными
`MYRMIDON_BOTD_NPM_NPX_QUOTA_BYTES` и `MYRMIDON_BOTD_CARGO_TARGET_QUOTA_BYTES` процесса botd.

## settings-en

| `MYRMIDON_BOTD_NPM_NPX_QUOTA_BYTES` | OPE-12110 | `536870912` (512 MiB) | Byte quota of `hermes/.npm/_npx` per bot. After the 24 h age pass, if the remaining entries weigh more, whole entries are removed oldest-first by newest mtime until the total fits; an entry held open by a process or written in the last 15 minutes is never removed | Unset or `0` — 512 MiB (there is no off switch); a very large value effectively disables the quota |
| `MYRMIDON_BOTD_CARGO_TARGET_QUOTA_BYTES` | OPE-12110 | `2147483648` (2 GiB) | Byte quota of the per-bot cargo target dir `hermes/.cache/cargo-target` (the image's `CARGO_TARGET_DIR`). Past it, whole profile dirs (`debug`, `release`, `<triple>`) are removed least recently written first; open and just-written ones stay | Unset or `0` — 2 GiB (there is no off switch); a very large value effectively disables the quota |

## settings-ru

| `MYRMIDON_BOTD_NPM_NPX_QUOTA_BYTES` | OPE-12110 | `536870912` (512 МиБ) | Квота в байтах на `hermes/.npm/_npx` у одного бота. После прохода по возрасту (24 ч), если оставшиеся записи весят больше, целые записи удаляются от самой давней по наибольшему mtime, пока сумма не уложится; запись, открытая процессом или изменённая за последние 15 минут, не удаляется | Не задана или `0` — 512 МиБ (выключателя нет); очень большое значение фактически отключает квоту |
| `MYRMIDON_BOTD_CARGO_TARGET_QUOTA_BYTES` | OPE-12110 | `2147483648` (2 ГиБ) | Квота в байтах на каталог сборки cargo бота `hermes/.cache/cargo-target` (`CARGO_TARGET_DIR` образа). Сверх неё целиком удаляются каталоги профилей (`debug`, `release`, `<triple>`), к которым писали давнее всего; открытые и только что записанные остаются | Не задана или `0` — 2 ГиБ (выключателя нет); очень большое значение фактически отключает квоту |
