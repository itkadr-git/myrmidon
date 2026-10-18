---
divergence-section: Брендинг
---

## changelog-en

### Browser preferences move to the Myrmidon namespace (DEBRAND-c)

- Browser storage now writes `myrmidon.*` and `myrmidon:*` keys. Startup migrates existing `paperclip.*` and `paperclip:*` local and session storage lazily without discarding a current Myrmidon value. The synchronous theme bootstrap migrates the selected theme before the first paint.

## changelog-ru

### Настройки браузера перенесены в пространство имён Myrmidon (DEBRAND-c)

- Браузерное хранилище теперь пишет ключи `myrmidon.*` и `myrmidon:*`. При старте существующие ключи `paperclip.*` и `paperclip:*` из local и session storage переносятся без потери актуального значения Myrmidon. Синхронный bootstrap темы переносит выбранную тему до первого рендера.

## divergence

| DEBRAND-c | Ключи состояния браузера UI перенесены из `paperclip.*` / `paperclip:*` в `myrmidon.*` / `myrmidon:*`. Новый bootstrap до React переносит все существующие ключи localStorage и sessionStorage только если новый ключ отсутствует или пуст, затем удаляет старый; inline-скрипт `index.html` применяет ту же миграцию темы до первого рендера. События и протокольные идентификаторы, не являющиеся хранилищем, сохранены | `ui/index.html`, `ui/src/main.tsx`, UI-модули состояния и компонентов | DEBRAND 1.6.6-c: видимые пользователю настройки браузера должны жить в пространстве имён Myrmidon без потери текущего состояния | `ui/src/lib/browser-storage.myrmidon.test.ts`; существующие UI-тесты обновлены на новые ключи | Никогда. При переносе вендорских файлов новые browser-storage ключи сразу писать как `myrmidon.*` / `myrmidon:*`; миграцию прежних ключей сохранить, пока поддерживаются обновления со старых версий | DEBRAND-c: browser storage namespace migration |
