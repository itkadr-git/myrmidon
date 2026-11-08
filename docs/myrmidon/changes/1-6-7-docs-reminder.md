## changelog-en

### One informational docs reminder comment on PRs that change API/schema/capability

A new GitHub Actions workflow (`.github/workflows/myrmidon-docs-reminder.yml`)
posts exactly one non-blocking comment when a pull request changes the API,
schema, or generated capability surface (`packages/paperclip-runner/generated/capability/`,
`server/**` schema files, `.agents/schemas/`) but ships neither a change
fragment (`docs/myrmidon/changes/`) nor a skill reference update
(`skills/myrmidon/references/`). The reminder is guarded by the
`<!-- docs-reminder -->` marker, so it is posted once per PR no matter how
many pushes; it never fails CI (docs-only and fork paths exit 0 silently).
Fragments stay mandatory only at the release cut
(`scripts/myrmidon/release/collect-fragments.mjs`); the reminder is a hint,
not a gate.

## changelog-ru

### Один информационный комментарий-подсказка на PR с изменениями API/схемы/возможностей

Новый workflow GitHub Actions (`.github/workflows/myrmidon-docs-reminder.yml`)
публикует ровно один необязательный комментарий, когда PR меняет поверхность
API, схемы или сгенерированных возможностей (`packages/paperclip-runner/generated/capability/`,
файлы схемы `server/**`, `.agents/schemas/`), но не содержит ни фрагмента
изменений (`docs/myrmidon/changes/`), ни обновления справочных материалов
навыка (`skills/myrmidon/references/`). Напоминание защищено маркером
`<!-- docs-reminder -->`, поэтому публикуется один раз на PR независимо от
количества пушей; оно никогда не валит CI (пути только-документация и форки
молча выходят с кодом 0). Фрагменты остаются обязательными только на срезе
релиза (`scripts/myrmidon/release/collect-fragments.mjs`); напоминание — это
подсказка, а не гейт.
