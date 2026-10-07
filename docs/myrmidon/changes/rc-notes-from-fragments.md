## changelog-en

### Release candidates publish with notes from change fragments (RC-NOTES)

- A release candidate is cut before the changelog is folded, so `release-body.mjs` now builds its notes from the pending change fragments (`docs/myrmidon/changes/*`, "changelog-en" blocks) when CHANGELOG has no section for the version. Final releases still require their CHANGELOG section. 1.6.5-rc.1 and rc.2 failed to publish for this reason.

## changelog-ru

### Кандидаты выпуска публикуются с заметками из фрагментов изменений (RC-NOTES)

- Кандидат срезается до сворачивания changelog, поэтому `release-body.mjs` для `-rc.N` собирает заметки из ожидающих фрагментов (`docs/myrmidon/changes/*`, блоки "changelog-en"), если раздела версии в CHANGELOG нет. Финальный выпуск по-прежнему требует свой раздел. Из-за этого не публиковались 1.6.5-rc.1 и rc.2.
