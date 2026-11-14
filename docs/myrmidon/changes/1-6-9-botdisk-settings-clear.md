## changelog-en

### Effective git mirror status in GET bot-disk and non-destructive PATCH general for botDisk (OPE-13110)

- `GET /api/myrmidon/bot-disk` now returns an `effective` block reflecting the active git mirror state (`gitMirrorEnabled`, `gitMirrorRepos`, `gitMirrorReposIsDefault`, `sharedCacheRoles`). When `gitMirrorRepos` is not configured in settings, it reflects the default repositories (`itkadr-git/myrmidon`, `itkadr-git/myrmidon-deploy`) and indicates `gitMirrorReposIsDefault: true`.
- Partial `botDisk` updates via `PATCH general` merge with existing stored `botDisk` keys instead of replacing the entire object, preventing omitted keys (such as `gitMirrorRepos`) from being cleared when updating other fields. Passing `null` resets the settings block.
- Updated `docs/myrmidon/SETTINGS.md` documentation for `general.botDisk.gitMirrorRepos` default and disable behaviour.

## changelog-ru

### Действующее состояние git-зеркала в GET bot-disk и неразрушающий PATCH general для botDisk (OPE-13110)

- Маршрут `GET /api/myrmidon/bot-disk` теперь отдаёт блок `effective` с действующим состоянием git-зеркала (`gitMirrorEnabled`, `gitMirrorRepos`, `gitMirrorReposIsDefault`, `sharedCacheRoles`). Если ключ `gitMirrorRepos` не задан в настройках, возвращаются репозитории по умолчанию (`itkadr-git/myrmidon`, `itkadr-git/myrmidon-deploy`) с флагом `gitMirrorReposIsDefault: true`.
- Частичное обновление `botDisk` через `PATCH general` теперь объединяется с сохранёнными ключами `botDisk` вместо полной перезаписи объекта, поэтому пропущенные ключи (например, `gitMirrorRepos`) не стираются при обновлении других полей. Передача `null` сбрасывает блок.
- В `docs/myrmidon/SETTINGS.md` обновлено описание умолчания и отключения для `general.botDisk.gitMirrorRepos`.
