## changelog-en

### DEVFLOW: collect queue health durations and thresholds (#1960)

- Environment overrides for devflow health thresholds:
  - `MYRMIDON_DEVFLOW_ENGINEER_IDLE_MS`: idle engineer alert threshold in milliseconds.
  - `MYRMIDON_DEVFLOW_REVIEW_QUEUE_MS`: review queue age alert threshold in milliseconds.
  - `MYRMIDON_DEVFLOW_RED_CI_MS`: red CI alert threshold in milliseconds.
  - `MYRMIDON_DEVFLOW_APPROVAL_MARKER_MS`: legacy alias for stale marker alert threshold in milliseconds.
  - `MYRMIDON_DEVFLOW_AUTO_MERGE_MS`: legacy alias for stalled merge alert threshold in milliseconds.
  - `MYRMIDON_DEVFLOW_REVIEW_ROUTER_MS`: legacy alias for stalled router alert threshold in milliseconds.
  - `MYRMIDON_DEVFLOW_APPROVED_NOT_MERGED_MS`: alert threshold in milliseconds for an approved pull request that is not merged (default 7200000, 2 h; the `approvedNotMergedMs` instance setting wins).
  - `MYRMIDON_DEVFLOW_NO_MERGES_MS`: alert threshold in milliseconds for a period without any merge (default 21600000, 6 h; the `noMergesMs` instance setting wins).

## changelog-ru

### DEVFLOW: сбор показателей здоровья очередей и пороговые значения (#1960)

- Переменные окружения для порогов здоровья devflow:
  - `MYRMIDON_DEVFLOW_ENGINEER_IDLE_MS`: порог оповещения о простое инженера в миллисекундах.
  - `MYRMIDON_DEVFLOW_REVIEW_QUEUE_MS`: порог возраста очереди ревью в миллисекундах.
  - `MYRMIDON_DEVFLOW_RED_CI_MS`: порог оповещения о красном CI в миллисекундах.
  - `MYRMIDON_DEVFLOW_APPROVAL_MARKER_MS`: устаревший псевдоним порога устаревания маркера в миллисекундах.
  - `MYRMIDON_DEVFLOW_AUTO_MERGE_MS`: устаревший псевдоним порога зависания автослияния в миллисекундах.
  - `MYRMIDON_DEVFLOW_REVIEW_ROUTER_MS`: устаревший псевдоним порога зависания роутера в миллисекундах.
  - `MYRMIDON_DEVFLOW_APPROVED_NOT_MERGED_MS`: порог оповещения об одобренном, но не влитом PR в миллисекундах (по умолчанию 7200000, 2 ч; настройка экземпляра `approvedNotMergedMs` важнее).
  - `MYRMIDON_DEVFLOW_NO_MERGES_MS`: порог оповещения о периоде без единого вливания в миллисекундах (по умолчанию 21600000, 6 ч; настройка экземпляра `noMergesMs` важнее).
