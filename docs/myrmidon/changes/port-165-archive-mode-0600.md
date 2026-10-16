## changelog-en

### The bot-disk archive writer enforces 0600/0640 regardless of umask (ARCHIVE-MODE)

- `docker/bot-runtime/botd/lib/archive.js` creates every archive file with
  restricted modes: `archive()` and `archiveTree()` wrap their pass in a
  `umask 0027` window (`withArchiveUmask`), so the child tools
  (`git bundle create`, `tar -cf`) land their bundle/tar at `0640`
  (directories `0750`), and the direct writes (the patch, `manifest.json`
  and its tmp file) pass an explicit `0600`. botd's disk-state and the
  attention/cooldown cache (`lib/cache.js`) are now born `0640` instead of
  `0644`.
- Why: the archive is the only copy of unpushed bot work, and all bots on a
  host share uid `10001`; a botd started with the default umask 022 (for
  example, an entrypoint without the umask 077 prologue) made every archive
  world-readable. The creation modes no longer depend on the inherited
  umask; the archive semantics (bundle/patch/tar layout, retention,
  verification) are unchanged and already-created archives are not touched.
- Tested in `scripts/myrmidon/bot-runtime/botd-archive.test.mjs` (files born
  0600/0640 and the archive dir 0750 under a permissive umask 022) and
  `scripts/myrmidon/bot-runtime/botd-cleanup-f13.test.mjs` (the dir.tar born
  0640).

## changelog-ru

### Писатель bot-disk-архива создаёт файлы 0600/0640 независимо от umask (ARCHIVE-MODE)

- `docker/bot-runtime/botd/lib/archive.js` создаёт каждый архивный файл с
  ограниченными правами: `archive()` и `archiveTree()` оборачивают проход в
  окно `umask 0027` (`withArchiveUmask`) — поэтому артефакты дочерних
  утилит (`git bundle create`, `tar -cf`) рождаются `0640` (каталоги
  `0750`), — а прямые записи (patch, `manifest.json` и его tmp) пишутся с
  явным `0600`. disk-state в `botd` и кэш attention/cooldown
  (`lib/cache.js`) теперь рождаются `0640` вместо `0644`.
- Зачем: архив — единственная копия незапушенной работы бота, а все боты
  хоста работают под одним uid `10001`; botd, стартовавший с umask 022 по
  умолчанию (например, entrypoint без пролога umask 077), делал каждый
  архив читаемым всем. Режимы создания больше не зависят от
  унаследованного umask; семантика архива (состав bundle/patch/tar,
  ретенция, верификация) не менялась, уже созданные архивы не трогаются.
- Проверено в `scripts/myrmidon/bot-runtime/botd-archive.test.mjs` (файлы
  рождаются 0600/0640, каталог архива 0750 при permisсивном umask 022) и
  `scripts/myrmidon/bot-runtime/botd-cleanup-f13.test.mjs` (dir.tar —
  0640).
