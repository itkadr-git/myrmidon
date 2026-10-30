## changelog-en

### Browser extension package built in CI (CLIENT-1-PKG)

- A new workflow builds `extension/` into `dist-extension/`, checks that every file the manifest names is in the build, and zips it. Pull requests and pushes to `main` get the zip as a workflow artifact; a tag `extension-v<manifest version>` also publishes it as a GitHub Release with a SHA-256 file.

## changelog-ru

### Пакет расширения браузера собирается в CI (CLIENT-1-PKG)

- Новый workflow собирает `extension/` в `dist-extension/`, проверяет, что все файлы из манифеста есть в сборке, и упаковывает в zip. Для pull request и пушей в `main` zip доступен как артефакт запуска; по тегу `extension-v<версия манифеста>` он дополнительно выкладывается GitHub Release вместе с файлом SHA-256.
