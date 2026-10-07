---
divergence-section: 1.6.5 — BOT-DISK H: порог раздела ботов по физике
settings-section: 1.6.5 — BOT-DISK-H10: bot partition thresholds
---

## changelog-en

### The bot partition threshold is read from the partition's physics (1.6.5 BOT-DISK-H, part H10)

- New instance settings `general.botDisk.partitionThresholdPercent` (85),
  `general.botDisk.partitionRefuseOpenPercent` (90) and
  `general.botDisk.partitionCriticalPercent` (95), validated as an ordered
  triple (85<90<95). Readable and writable without a restart via
  `GET`/`PATCH /api/myrmidon/host-disk/partition` (PATCH is instance-admin
  only); env vars `MYRMIDON_BOT_PARTITION_THRESHOLD_PERCENT`,
  `MYRMIDON_BOT_PARTITION_REFUSE_OPEN_PERCENT`,
  `MYRMIDON_BOT_PARTITION_CRITICAL_PERCENT` are the first-start defaults.
- The host-disk sweep measures the bot partition through dockergate
  `GET /myrmidon/disk` (contract C5) instead of inferring it from the server's
  own `/data`: on 07.10.2026 the partition filled to 100 % while `/data`
  stayed fine. The `host_disk_alert` card counts against the partition from
  the warn threshold and goes critical at the critical threshold. Without
  dockergate data the previous statfs behaviour is unchanged and the
  partition is reported as not measured. Set `MYRMIDON_DOCKERGATE_URL` to the
  dockergate base URL to enable the measurement.
- From the refuse-open threshold the desired state of the bot workspaces
  reports `pressure.level = "hard"` (grace 0): `myr-ws open` refuses new
  copies. The board side of the C3 route is part H1c; H10 exports the
  evaluation (`botPartitionThresholdRuntime`) the route reads.
- At the critical threshold the owner receives a Telegram message through the
  existing owner-cards channel (the telegram-notify outbox), once per
  crossing — the latch re-arms only after the partition drops below the warn
  threshold.

## changelog-ru

### Порог раздела ботов считается по физике раздела (1.6.5 BOT-DISK-H, часть H10)

- Новые настройки экземпляра `general.botDisk.partitionThresholdPercent` (85),
  `general.botDisk.partitionRefuseOpenPercent` (90) и
  `general.botDisk.partitionCriticalPercent` (95), валидируются как упорядоченная
  тройка (85<90<95). Читаются и меняются без перезапуска через
  `GET`/`PATCH /api/myrmidon/host-disk/partition` (PATCH — только админ
  инстанса); переменные `MYRMIDON_BOT_PARTITION_THRESHOLD_PERCENT`,
  `MYRMIDON_BOT_PARTITION_REFUSE_OPEN_PERCENT`,
  `MYRMIDON_BOT_PARTITION_CRITICAL_PERCENT` — дефолты первого старта.
- Свип host-disk измеряет раздел ботов через dockergate `GET /myrmidon/disk`
  (контракт C5), а не по `/data` сервера: 07.10.2026 раздел дошёл до 100 %,
  пока `/data` был в норме. Карточка `host_disk_alert` считает по разделу с
  порога предупреждения и становится критической с критического порога. Без
  данных dockergate — прежнее поведение по statfs, раздел помечен как не
  измеренный. Задайте `MYRMIDON_DOCKERGATE_URL` — базовый URL dockergate, —
  чтобы включить измерение.
- С порога отказа открытия желаемое состояние рабочих копий ботов сообщает
  `pressure.level = "hard"` (grace 0): `myr-ws open` отказывает в новых копиях.
  Серверная сторона маршрута C3 — задача H1c; H10 экспортирует оценку
  (`botPartitionThresholdRuntime`), которую маршрут читает.
- С критического порога владелец получает сообщение в Telegram через
  существующий канал карточек владельца (outbox telegram-notify), один раз на
  пересечение — защёлка переармится только после падения раздела ниже порога
  предупреждения.

## settings-en

| `general.botDisk.partitionThresholdPercent` | 1.6.5-BOT-DISK-H10 | 85 | Fill level of the bot partition (measured via dockergate `GET /myrmidon/disk`) at which the `host_disk_alert` card appears. Must be below `partitionRefuseOpenPercent` | `MYRMIDON_BOT_PARTITION_THRESHOLD_PERCENT` |
| `general.botDisk.partitionRefuseOpenPercent` | 1.6.5-BOT-DISK-H10 | 90 | From this fill level the workspace desired state reports `pressure.level = "hard"` and `myr-ws open` refuses new copies (grace 0). Must be below `partitionCriticalPercent` | `MYRMIDON_BOT_PARTITION_REFUSE_OPEN_PERCENT` |
| `general.botDisk.partitionCriticalPercent` | 1.6.5-BOT-DISK-H10 | 95 | From this fill level the card is critical and the owner gets a Telegram message through the owner-cards channel, once per crossing | `MYRMIDON_BOT_PARTITION_CRITICAL_PERCENT` |
| `MYRMIDON_DOCKERGATE_URL` | 1.6.5-BOT-DISK-H10 | unset | Base URL of dockergate on the bot host (e.g. `http://host.docker.internal:3399`). Unset disables the partition measurement: the sweep keeps the statfs behaviour and the partition is reported as not measured | env only |

## settings-ru

| `general.botDisk.partitionThresholdPercent` | 1.6.5-BOT-DISK-H10 | 85 | Заполнение раздела ботов (измерение через dockergate `GET /myrmidon/disk`), с которого появляется карточка `host_disk_alert`. Должно быть меньше `partitionRefuseOpenPercent` | `MYRMIDON_BOT_PARTITION_THRESHOLD_PERCENT` |
| `general.botDisk.partitionRefuseOpenPercent` | 1.6.5-BOT-DISK-H10 | 90 | С этого заполнения желаемое состояние рабочих копий сообщает `pressure.level = "hard"`, и `myr-ws open` отказывает в новых копиях (grace 0). Должно быть меньше `partitionCriticalPercent` | `MYRMIDON_BOT_PARTITION_REFUSE_OPEN_PERCENT` |
| `general.botDisk.partitionCriticalPercent` | 1.6.5-BOT-DISK-H10 | 95 | С этого заполнения карточка критическая, а владелец получает сообщение в Telegram через канал карточек владельца, один раз на пересечение | `MYRMIDON_BOT_PARTITION_CRITICAL_PERCENT` |
| `MYRMIDON_DOCKERGATE_URL` | 1.6.5-BOT-DISK-H10 | не задано | Базовый URL dockergate на хосте ботов (например `http://host.docker.internal:3399`). Не задано — измерение раздела выключено: свип работает по statfs, раздел помечен как не измеренный | только env |
