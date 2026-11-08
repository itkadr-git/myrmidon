## changelog-en

### Docs: register the second vendor attribution spelling kept by the brand guards

- PR #2103 (1.7 REBRAND F) extended the exact allowlists of the doc-side brand
  guards `scripts/myrmidon/docs-branding-guard.mjs` and
  `scripts/myrmidon/brand-release-audit.mjs` with the second legal-attribution
  spelling `Base: Paperclip` — the localized "Upstream base … (MIT)"
  provenance line that About and the exported README render — next to the
  existing `Based on Paperclip`. The guides that enumerate what stays under
  the vendor name on purpose (`docs/myrmidon/guides/docs-branding.md` and
  `docs/myrmidon/guides/docs-branding.ru.md`) still named only the one
  attribution line; they now record the second spelling as deliberate,
  attribution-scoped, and covered by the build-side vendor-name gate content
  patterns. Docs only: no behavior change.

## changelog-ru

### Доки: зарегистрировано второе написание атрибуции вендора, которое держат сторожи бренда

- PR #2103 (1.7 REBRAND F) дополнил точные аллоулисты сторожей документации
  `scripts/myrmidon/docs-branding-guard.mjs` и
  `scripts/myrmidon/brand-release-audit.mjs` вторым написанием юридической
  атрибуции `Base: Paperclip` — локализованная строка происхождения
  «Upstream base … (MIT)» с версией, которую показывают About и экспортируемый
  README — рядом с существующей `Based on Paperclip`. Руководства,
  перечисляющие намеренно сохранённые упоминания имени вендора
  (`docs/myrmidon/guides/docs-branding.md` и
  `docs/myrmidon/guides/docs-branding.ru.md`), называли только одну строку
  атрибуции; теперь они фиксируют второе написание как намеренное,
  ограниченное атрибуцией и покрытое шаблонами допустимого текста сторожа
  собранной версии. Только документация: изменения поведения нет.
