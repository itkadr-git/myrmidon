## settings-en-append

<!-- section: BOT-DISK E — host disk usage signal -->
<!-- occurrence: 1 -->
When `git bundle create` fails on a damaged repository (any reason other than
an empty bundle), the whole removed copy — `.git` and untracked files
included — is kept as one fallback archive `archive/<KEY>-<ts>.full.tar.zst`
next to the bundle/patch/untracked-tar set, and the manifest entry is marked
`incompleteBundle: true`. The fallback tar is bounded: a directory over
2 GiB is left in place instead of filling the archive disk, the archive
filesystem must have at least twice the directory's size free (and never less
than 1 GiB) before the tar is attempted, and every spawned git/tar carries a
10-minute timeout, so a hung tool cannot hold a cleanup pass.

## settings-ru-append

<!-- section: BOT-DISK E — host disk usage signal -->
Если `git bundle create` падает на повреждённом репозитории (по любой причине,
кроме пустого bundle), вся удаляемая копия — вместе с `.git` и untracked —
сохраняется одним запасным архивом `archive/<KEY>-<ts>.full.tar.zst` рядом с
набором bundle/patch/untracked-tar, а в манифесте у записи выставляется
`incompleteBundle: true`. Запасной tar ограничен: каталог тяжелее 2 ГиБ
остаётся на месте, чтобы не забивать архивный диск; на архивной ФС должно
быть свободно не меньше двух размеров каталога (и в любом случае не меньше
1 ГиБ), иначе tar даже не запускается; каждый вызов git/tar имеет таймаут
10 минут, поэтому зависший инструмент не может удерживать проход уборки.
