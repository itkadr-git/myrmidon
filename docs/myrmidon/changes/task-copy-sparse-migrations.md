## changelog-en

### Task copies check out only the latest drizzle snapshot

`myr-ws open` now creates a new task copy with a non-cone sparse checkout. In
`packages/db/src/migrations/meta` the copy holds `_journal.json` and the latest
snapshot named by the journal (highest `idx`, not a hard-coded file name); the
rest of the tree is checked out in full. The 263 snapshots of about 1.1 MB each
were 57% of a 500 MB copy, and `drizzle-kit generate` reads only the journal
and the last snapshot. Existing copies, scratch copies and review copies are
not changed, and a repository without a drizzle journal gets a full checkout.
A new snapshot is added with `git add --sparse`; checks that read every
snapshot (`check-migration-snapshots`, `pnpm db:renumber`) need
`git sparse-checkout disable` first. This changes the bot image (`myr-ws`), so
it reaches bots with the next bot image roll.

## changelog-ru

### Копии задач берут только последний снимок drizzle

`myr-ws open` теперь создаёт новую копию задачи с sparse checkout (режим
non-cone). В `packages/db/src/migrations/meta` в копии лежат `_journal.json` и
последний снимок по журналу (наибольший `idx`, имя файла не зашито), остальное
дерево выгружается полностью. 263 снимка по ~1,1 МБ занимали 57% копии в 500 МБ,
а `drizzle-kit generate` читает только журнал и последний снимок. Уже
созданные, scratch- и review-копии не меняются, репозиторий без журнала drizzle
выгружается целиком. Новый снимок добавляется через `git add --sparse`;
проверкам, которым нужны все снимки (`check-migration-snapshots`,
`pnpm db:renumber`), сначала нужен `git sparse-checkout disable`. Изменение
затрагивает образ ботов (`myr-ws`), до ботов дойдёт с очередным перекатом образа.
