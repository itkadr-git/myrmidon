## changelog-en

### The host-disk sweep measures the real mounted path and stops spamming when it cannot (1.6.5 F-03)

- `MYRMIDON_HOST_DISK_DATA_ROOT` points the sweep at the directory that is
  actually mounted into the server container (default `/data`). When the
  path is missing the sweep result switches to `state: "unmeasured"` with a
  `measuredPath: null` and an `error` text that names the missing path and
  the setting to fix — instead of one `host disk usage could not be read`
  log line per tick.
- The transition into `unmeasured` is logged once at error level; further
  failed ticks are debug, with the error repeated at most once an hour. When
  the path appears, the measurement resumes without a restart and one info
  line records the recovery.
- Every path in `MYRMIDON_HOST_DISK_CONSUMER_PATHS` is measured on its own
  filesystem (`usedPercent`/`usedBytes`/`totalBytes`/`freeBytes` per path) —
  a consumer can live on a different filesystem than the data root. The main
  result stays the data root; the per-path list is returned as
  `measurements` from `GET /api/myrmidon/host-disk` together with the new
  `state` and `error` fields.
- `post-boot-check.sh` fails red when the host-disk sweep reports
  `measuredPath: null`, so a board that boots blind does not pass the gate.
  `POST_BOOT_CHECK_HOST_DISK=off` disables the check.

## changelog-ru

### Свип host-disk измеряет реально смонтированный путь и не спамит, когда пути нет (1.6.5 F-03)

- `MYRMIDON_HOST_DISK_DATA_ROOT` указывает свипу каталог, реально
  смонтированный в контейнер сервера (умолчание `/data`). Если пути нет,
  результат свипа переходит в `state: "unmeasured"` с `measuredPath: null`
  и текстом `error`, который называет отсутствующий путь и настройку для
  исправления, — вместо строки `host disk usage could not be read` на
  каждый тик.
- Переход в `unmeasured` пишется один раз на уровне error; дальнейшие
  неудачные тики — debug, error повторяется не чаще раза в час. Когда путь
  появляется, измерение возобновляется без перезапуска, а восстановление
  фиксируется одной записью info.
- Каждый путь из `MYRMIDON_HOST_DISK_CONSUMER_PATHS` измеряется на своей
  файловой системе (`usedPercent`/`usedBytes`/`totalBytes`/`freeBytes` по
  каждому пути) — потребитель может жить не на той ФС, что корень данных.
  Главный результат — по корню данных; список по путям отдаётся как
  `measurements` из `GET /api/myrmidon/host-disk` вместе с новыми полями
  `state` и `error`.
- `post-boot-check.sh` падает красным, когда свип host-disk сообщает
  `measuredPath: null`: доска, поднявшаяся вслепую, не проходит гейт.
  `POST_BOOT_CHECK_HOST_DISK=off` выключает проверку.

## settings-en

| `MYRMIDON_HOST_DISK_DATA_ROOT` | 1.6.5-F-03 | `/data` | Directory whose filesystem usage the host-disk sweep measures. Point it at the path actually mounted into the server container | change the value |
| `MYRMIDON_HOST_DISK_CONSUMER_PATHS` | 1.6.5-F-03 | the data root | Comma-separated list of directories, each measured on its own filesystem and returned in `measurements` | change the value |
| `POST_BOOT_CHECK_HOST_DISK` | 1.6.5-F-03 | `on` | post-boot-check.sh fails red when the host-disk sweep reports `measuredPath: null` | `off` |

## settings-ru

| `MYRMIDON_HOST_DISK_DATA_ROOT` | 1.6.5-F-03 | `/data` | Каталог, чьё заполнение ФС измеряет свип host-disk. Укажите путь, реально смонтированный в контейнер сервера | изменить значение |
| `MYRMIDON_HOST_DISK_CONSUMER_PATHS` | 1.6.5-F-03 | корень данных | Список каталогов через запятую; каждый измеряется на своей ФС и отдаётся в `measurements` | изменить значение |
| `POST_BOOT_CHECK_HOST_DISK` | 1.6.5-F-03 | `on` | post-boot-check.sh падает красным, когда свип host-disk сообщает `measuredPath: null` | `off` |
