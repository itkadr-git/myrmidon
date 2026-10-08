---
---
## changelog-en

### Release publish fits GitHub's size limit

- A release body over GitHub's 125 000-character limit was refused (HTTP 422, 1.6.5-rc.11). The notes section is now cut at a line boundary to keep the body under 120 000 characters and ends with a link to the full section of `docs/myrmidon/CHANGELOG.md` on the same tag; the component digest table is never cut.

## changelog-ru

### Публикация релиза укладывается в лимит GitHub

- Текст релиза длиннее 125 000 символов GitHub отклонял (HTTP 422, 1.6.5-rc.11). Раздел заметок теперь обрезается по границе строки, чтобы текст был не длиннее 120 000 символов, и заканчивается ссылкой на полный раздел `docs/myrmidon/CHANGELOG.md` на том же теге; таблица образов не обрезается.
