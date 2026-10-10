## changelog-en

### The bot runtime entrypoint sets umask 077: run files are born owner-only (BOT-UMASK)

- `docker/bot-runtime/entrypoint.sh` sets `umask 077` right after its `set
  -euo pipefail` prologue, before the first mkdir/write of the bot tree, and
  logs one line (`[bot-runtime] umask 077 (run files owner-only)`). The umask
  is inherited by every child of the entrypoint (gateway → session →
  terminal/tool processes), so every file a run creates — scratch dumps,
  cache, tmp helpers written by plain shell redirection — is born `0600`
  (directories `0700`) without any cooperation from the workload.
- Why: every bot on a host runs as uid `10001`; the mode bits are the only
  barrier between one run's scratch/cache and another bot's processes, and
  the default umask 022 made run artifacts world-readable inside the shared
  uid. There is no `UMASK` environment variable and no pam-umask (no login
  session), so the entrypoint is the only point that covers all children.
- Tested in `scripts/myrmidon/bot-runtime/entrypoint.test.mjs`
  (`docker/bot-runtime/entrypoint.sh umask 077` describe): a static ordering
  check that the umask line precedes the first file write, and a behavioural
  probe that exec's a stub hermes recording its inherited umask — `0077`,
  with a file born `0600` and a directory `0700`. The probe is red on the
  base revision and green with the fix.

## changelog-ru

### Entrypoint bot-runtime выставляет umask 077: файлы прогона рождаются owner-only (BOT-UMASK)

- `docker/bot-runtime/entrypoint.sh` выставляет `umask 077` сразу после
  пролога `set -euo pipefail`, до первого mkdir/записи дерева бота, и пишет
  одну строку в лог (`[bot-runtime] umask 077 (run files owner-only)`).
  umask наследуется каждым дочерним процессом entrypoint'а
  (gateway → session → terminal/tool), поэтому любой файл, который создаёт
  прогон, — scratch-дампы, кэш, tmp-хелперы, записанные shell-редиректом, —
  рождается `0600` (каталоги — `0700`) без дисциплины со стороны нагрузки.
- Зачем: все боты на хосте работают под одним uid `10001`; биты режима —
  единственный барьер между scratch/cache одного прогона и процессами другого
  бота, а umask 022 по умолчанию делал артефакты прогона читаемыми внутри
  общего uid. Переменной окружения `UMASK` не существует, pam-umask не
  задействован (нет login-сессии), поэтому entrypoint — единственная точка,
  покрывающая всех детей.
- Проверено в `scripts/myrmidon/bot-runtime/entrypoint.test.mjs` (describe
  `docker/bot-runtime/entrypoint.sh umask 077`): статическая проверка, что
  строка umask стоит раньше первой файловой записи, и поведенческая проба,
  которая exec'ит заглушку hermes, записывающую унаследованный umask, —
  `0077`, файл рождается `0600`, каталог `0700`. Проба красная на
  base-ревизии и зелёная с фиксом.
