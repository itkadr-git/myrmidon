## changelog-en

### CI: affected tests now always run static guards that read app.ts via fs (OPE-12295)

- The `tests (affected)` tier now always includes
  `server/src/myrmidon/app-plugin.myrmidon.test.ts` when one of the shared
  guard triggers changes (`server/src/app.ts`, `server/src/index.ts`,
  `server/src/myrmidon/app-plugin*.ts`, `docs/myrmidon/FLAGS.md`,
  `docs/myrmidon/SETTINGS.md`). The suite reads `app.ts` through
  `readFileSync` (not an import), so the dependency graph could not discover
  it; PR #876 merged with a green PR CI but red main because the mounts
  snapshot was stale.

## changelog-ru

### CI: affected-тесты теперь всегда запускают статические стражи, читающие app.ts через fs (OPE-12295)

- Ярус `tests (affected)` теперь всегда включает
  `server/src/myrmidon/app-plugin.myrmidon.test.ts` при изменении одного из
  общих триггеров стражей (`server/src/app.ts`, `server/src/index.ts`,
  `server/src/myrmidon/app-plugin*.ts`, `docs/myrmidon/FLAGS.md`,
  `docs/myrmidon/SETTINGS.md`). Сьют читает `app.ts` через `readFileSync`
  (не импортом), поэтому граф зависимостей не мог его обнаружить; PR #876
  влился с зелёным CI на PR, но красным main, потому что снимок mounts был
  устаревшим.
