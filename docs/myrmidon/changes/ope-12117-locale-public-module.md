## changelog-en

### Public locale module: upload and current dictionary endpoints (1.7 LOCALE-UPLOAD, OPE-12117)

- `POST /api/locale/upload` (board-only) accepts a custom UI dictionary as a
  JSON body (`locale` + `catalog`), a raw JSON string in `content`, or a
  multipart `.json` file (locale detected from the file name, an explicit
  `locale` field/query wins). The ru/en dictionary is validated against the
  base English catalog and stored as a new version in
  `instance_settings.general.customLocales` with a SHA-256 checksum and a
  per-locale version bump. Invalid locale or invalid JSON answers 400
  (`INVALID_LOCALE` / `INVALID_CATALOG_JSON`); oversized files answer
  `FILE_TOO_LARGE`.
- `GET /api/locale/current` returns the active custom dictionary (or the
  base English reference when nothing is stored yet) with version, checksum,
  key count and the `active` flag.
- Module: `server/src/modules/locale/` (routes + service + contract tests),
  mounted in `server/src/app.ts` right after the OPE-10187 validator routes.

## changelog-ru

### Публичный модуль локали: загрузка и текущий словарь (1.7 LOCALE-UPLOAD, OPE-12117)

- `POST /api/locale/upload` (только board) принимает пользовательский
  словарь интерфейса как JSON-тело (`locale` + `catalog`), строку JSON в
  поле `content` или multipart-файл `.json` (локаль определяется по имени
  файла, явное поле/параметр `locale` имеет приоритет). Словарь ru/en
  проверяется по эталонному каталогу en и сохраняется как новая версия в
  `instance_settings.general.customLocales` с SHA-256 контрольной суммой и
  инкрементом версии на локаль. Невалидная локаль или JSON — 400
  (`INVALID_LOCALE` / `INVALID_CATALOG_JSON`); слишком большой файл —
  `FILE_TOO_LARGE`.
- `GET /api/locale/current` возвращает активный пользовательский словарь
  (или эталонный en, если загрузок ещё нет) с версией, контрольной суммой,
  числом ключей и флагом `active`.
- Модуль: `server/src/modules/locale/` (маршруты + сервис + контрактные
  тесты), смонтирован в `server/src/app.ts` сразу после маршрутов-валидаторов
  OPE-10187.
