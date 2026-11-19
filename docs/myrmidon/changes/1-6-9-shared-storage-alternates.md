---
settings-section: Track 1 — bot runtime, fleet storage
---

## changelog-en

### Old bot git bases attach to the fleet mirror and re-repack on alternates change (OPE-13118)

Bot dev bases live under `/data/hermes/.myrmidon/git-base/<owner>/<repo>.git`.
72 of 126 fleet bases had no `objects/info/alternates` and together held
14.3 GiB of object data duplicated in the fleet mirror `/cache/git`.

Two gaps kept them detached:

- `findMirror` in `myr-ws/lib/base.js` probed the mirror root with the
  lowercased owner/repo path only. Mirror directories such as
  `BastionPrime/wellboard.git` were never found, so 17 wellboard bases got
  no alternates. `findMirror` now falls back to a case-insensitive scan of
  `/cache/git/*/*` when the exact path misses.
- The botd git migration (`botd/lib/git-migration.js`) only pruned and
  repacked; it never wrote alternates, and its `.repack-migrated` marker
  suppressed any later repack once a mirror appeared. The migration now
  calls `syncMirrorAlternates` from `myr-ws/lib/base.js` before repack and
  the marker records the mirror objects directory the repack used. When
  alternates appear or change, the base is re-migrated and `repack -l`
  drops the duplicated objects.

The "repack only on an idle bot" fleet lock is unchanged.

## changelog-ru

### Старые git-базы ботов подключаются к зеркалу флота и повторяют repack при смене alternates (OPE-13118)

Базы разработки ботов лежат в `/data/hermes/.myrmidon/git-base/<owner>/<repo>.git`.
72 из 126 баз флота не имели `objects/info/alternates` и вместе держали
14,3 ГиБ объектов, дублирующих зеркало флота `/cache/git`.

Две проблемы держали их отсоединёнными:

- `findMirror` в `myr-ws/lib/base.js` проверял только путь с owner/repo
  в нижнем регистре. Каталоги зеркала вроде `BastionPrime/wellboard.git`
  не находились, и 17 баз wellboard не получали alternates. Теперь
  `findMirror` при промахе делает обход `/cache/git/*/*` без учёта регистра.
- Миграция botd (`botd/lib/git-migration.js`) только чистила и упаковывала;
  alternates она не писала, а маркер `.repack-migrated` подавлял любой
  повторный repack, когда зеркало появлялось. Миграция теперь вызывает
  `syncMirrorAlternates` из `myr-ws/lib/base.js` перед repack, а маркер
  хранит каталог объектов зеркала, с которым repack был сделан. При
  появлении или смене alternates база мигрируется заново и `repack -l`
  убирает дубли объектов.

Правило «repack только у свободного бота» не изменилось.
