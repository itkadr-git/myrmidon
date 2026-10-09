---
divergence-section: 1.6.1 — BOT-DISK B: общий кэш пакетов для контейнеров ботов
---

## changelog-en

### botd cleanup is idempotent, silent about foreign owners and never leaves work unarchived (1.6.5 BOT-DISK-H, F-13 part A)

- A removal of a path that is already gone is success: `guardedRemove` returns
  `already gone` instead of raising ENOENT, `verifyEntry` passes an archive whose
  files all vanished, and `retain` drops such manifest entries silently. The
  ~160 ENOENT error lines per 1.5 h the journal carried are gone by design.
- A permission failure on a removal (`EACCES`/`EPERM` — the path belongs to another
  uid) is a deferred pass, not an error: the path stays exactly where it is, ownership
  is never changed, and `botd-attention.json` guarantees one attention line per path
  per hour carrying the blocking code and the owner uid from `lstat`.
- When `git bundle create` fails for a reason other than "empty bundle" (a damaged
  repository, a hung git), the whole directory — `.git` and untracked files included —
  goes into one fallback `<base>.full.tar.zst`; a tar that lists back is a complete
  copy of the directory, so it clears the removal (no more "archive-incomplete ... not
  removed" keeping the disk full), and the manifest entry is marked
  `incompleteBundle: true`. The fallback tar counts in the retention quota. If even
  the tar cannot be written or verified, nothing is deleted.
- The rhythm of the rules: the same op on the same path is not attempted more than
  once per hour (`botd-cooldown.json`); a repeat inside the window is a silent skip —
  no log line, no report row. Every executed pass ends with one summary line
  `botd loop: cleaned N, deferred M (reasons…)` instead of per-path noise.
- No new environment settings; the two caches live next to `disk-state.json` under
  `$MYRMIDON_WS_HOME` and are best-effort: an unwritable cache only loses the silence.

## changelog-ru

### Уборка botd идемпотентна, молчит о чужих владельцах и не оставляет работу без архива (1.6.5 BOT-DISK-H, F-13 часть A)

- Удаление уже отсутствующего пути — успех: `guardedRemove` возвращает `already gone`
  вместо ошибки ENOENT, `verifyEntry` считает готовым архив, чьи файлы все исчезли, а
  `retain` молча снимает такие строки из манифеста. ~160 строк ошибок ENOENT за 1,5 ч
  из журнала убираются по построению.
- Отказ права на удаление (`EACCES`/`EPERM` — путь принадлежит другому uid) —
  отложенный проход, а не ошибка: путь остаётся на месте, владество не меняется, а
  `botd-attention.json` даёт одну строку внимания на путь в час с кодом отказа и uid
  владельца из `lstat`.
- Если `git bundle create` упал по причине, отличной от «empty bundle» (повреждённый
  репозиторий, зависший git), весь каталог — вместе с `.git` и untracked — уходит в
  запасной `<base>.full.tar.zst`; tar, который перечитывается назад, — полная копия
  каталога, поэтому он разрешает удаление (больше нет «archive-incomplete … not
  removed», держащих диск), а строка манифеста помечается `incompleteBundle: true`.
  Запасной tar учитывается в квоте хранения. Если не удалось написать или проверить
  даже tar — ничего не удаляется.
- Ритм правил: одно и то же действие на одном пути не выполняется чаще раза в час
  (`botd-cooldown.json`); повтор внутри окна — тихий пропуск без строки журнала и
  строки отчёта. Каждый выполненный проход заканчивается одной итоговой строкой
  `botd loop: cleaned N, deferred M (причины…)` вместо шума по каждому пути.
- Новых настроек окружения нет; оба кэша лежат рядом с `disk-state.json` в
  `$MYRMIDON_WS_HOME` и являются best-effort: незаписываемый кэш теряет только тишину.

## divergence

| ID | Что изменено | Файлы | Зачем | Тесты | Когда снимать | Ссылка |
|---|---|---|---|---|---|---|
| 1.6.5-BOT-DISK-F13 | Уборка бота идемпотентна и молчалива: `guardedRemove` (ENOENT = `already gone`, EACCES/EPERM = отложенный `foreign-uid` без удаления и без смены владельца), два кэша ритма в `$MYRMIDON_WS_HOME` (`botd-attention.json` — одна строка внимания на путь в час с uid из `lstat`; `botd-cooldown.json` — то же действие на том же пути не чаще раза в час, повтор — тихий пропуск), итоговая строка прохода `cleaned N, deferred M (причины…)`, запасной `*.full.tar.zst` при падении `git bundle create` (не «empty bundle») с проверкой перечитыванием, флагом манифеста `incompleteBundle` и учётом в квоте `retain` | `docker/bot-runtime/botd/{botd,lib/remove.js,lib/cache.js,lib/loop.js,lib/archive.js,lib/legacy.js}` (наши файлы образа бота) | 487 EACCES + ~160 ENOENT + ~160 archive-incomplete за 1,5 ч на бою: журнал захлёбывался, диск держали каталоги, которые нечего было удалять уже («already gone») или которые нельзя удалять (чужой uid), а work без bundle оставались без архива навсегда. Политика данных: при сомнении — не удалять; при отказе права — фиксировать нарушение, а не чинить его молча | `scripts/myrmidon/bot-runtime/botd-cleanup-f13.test.mjs` (ENOENT→успех; EACCES→один сигнал внимания с uid, второй проход тихий, каталог на месте; падение bundle→полный tar создан, перечитан, каталог удалён, манифест помечен; кулдаун <1 ч не вызывает исполнитель; итоговая строка прохода), плюс зелёные `botd-{loop,archive,legacy}.test.mjs` и гейт Dockerfile | Никогда, наше поведение образа бота | (этот PR) |
