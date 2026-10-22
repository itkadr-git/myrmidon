---
divergence-section: Трек 6 — безопасность и модели
---

## changelog-en

### One installation id, owned by the board (OPE-8836)

- The installation id is now stored in the board database (table
  `myrmidon_install_identity`, migration `0404_install_identity`) and never
  changes. On the first start it is `MYR_LICENSE_INSTANCE_ID` if set, else
  `myr-` + 20 hex of `sha256(machine-id)` (the same formula as before, so
  licenses already issued stay valid), else `myr-` + 20 hex of a random UUID.
  A later change of the machine id or of the variable does not touch it.
- `GET /api/licensing/install-id`, the Licenses screen and the license check
  read the id only from the database; none of them reads the machine id.
- At start the board writes the id to the file `instance-id` in the license
  directory (`dirname(MYR_LICENSE_PATH)`, default `/etc/myrmidon-license`) for
  the closed modules: atomically, mode 0644. If the directory is not writable
  the board logs a warning and starts anyway.
- A license issued for another installation now says so with both ids: the one
  the license was issued for and the id of this board, on the screen and in the
  API (`licenseInstanceId`, `boardInstanceId`, `message`).
- `MYR_LICENSE_STATE_DIR` is no longer used by the board.

## changelog-ru

### Один идентификатор установки, за которым следит доска (OPE-8836)

- Идентификатор установки теперь хранится в базе доски (таблица
  `myrmidon_install_identity`, миграция `0404_install_identity`) и никогда не
  меняется. При первом старте это `MYR_LICENSE_INSTANCE_ID`, если задан, иначе
  `myr-` + 20 hex от `sha256(machine-id)` (та же формула, что раньше, поэтому
  уже выданные лицензии остаются действительными), иначе `myr-` + 20 hex от
  случайного UUID. Последующая смена machine-id или переменной его не трогает.
- `GET /api/licensing/install-id`, экран «Лицензии» и проверка лицензии берут
  идентификатор только из базы; machine-id никто из них не читает.
- При старте доска записывает идентификатор в файл `instance-id` в каталоге
  лицензии (`dirname(MYR_LICENSE_PATH)`, по умолчанию `/etc/myrmidon-license`)
  для закрытых модулей: атомарно, права 0644. Если каталог недоступен на
  запись, доска пишет предупреждение в журнал и всё равно стартует.
- Лицензия, выданная для другой установки, теперь показывает оба
  идентификатора: на какой она выдана и идентификатор этой доски, на экране и в
  API (`licenseInstanceId`, `boardInstanceId`, `message`).
- `MYR_LICENSE_STATE_DIR` доска больше не использует.

## divergence

| 1.6.6-LIC-ONE-ID | Таблица `myrmidon_install_identity` (одна строка, идентификатор установки), запись файла `instance-id` в каталог лицензии при старте | `packages/db/src/schema/index.ts` (экспорт с меткой `myrmidon(OPE-8836)`), миграция `0404_install_identity.sql` и мета, `server/src/index.ts` и `server/src/app.ts` (строки с меткой `myrmidon(OPE-8836)`) | Лицензии привязаны к доске: идентификатор должен быть один, постоянный и общий для экрана, проверки и модулей, а не пересчитываться из machine-id в каждом месте | `server/src/myrmidon/licensing/install-id.myrmidon.test.ts` (embedded PG: формула, повторный старт, генерация, переменная, файл), `server/src/myrmidon/licensing/client-licensing.myrmidon.test.ts` (оба идентификатора при несовпадении) | Таблица аддитивна: откат образа её игнорирует; убрать строки с меткой и каталог лицензирования | (этот PR) |
