## changelog-en

### stack-registry: rename PAPERCLIP_MIGRATION_SUPPORTED_VERSION to MYRMIDON_MIGRATION_SUPPORTED_VERSION

- Internal constant of the stack-registry update panel (declaration in
  `domain.ts` plus two imports in `collector.ts`/`index.ts`), renamed after
  the REBRAND-C ratchet so no new `PAPERCLIP_*` name enters the codebase.
  `MYRMIDON_MIGRATION_SUPPORTED_VERSION` pins the vendor Paperclip release
  supported by the migration schema (`schema-paperclip-v2026.1106.0.sql`);
  it is a code constant, not an environment setting.

## changelog-ru

### stack-registry: переименование PAPERCLIP_MIGRATION_SUPPORTED_VERSION в MYRMIDON_MIGRATION_SUPPORTED_VERSION

- Внутренняя константа панели обновлений stack-registry (объявление в
  `domain.ts` плюс два импорта в `collector.ts`/`index.ts`), переименована
  после REBRAND-C-ратчета, чтобы в кодовой базе не появлялось новых имён
  `PAPERCLIP_*`. `MYRMIDON_MIGRATION_SUPPORTED_VERSION` фиксирует версию
  вендорского Paperclip, поддерживаемую схемой миграции
  (`schema-paperclip-v2026.1106.0.sql`); это константа кода, не настройка
  окружения.
