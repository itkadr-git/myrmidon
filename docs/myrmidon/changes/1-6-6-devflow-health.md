## changelog-en

### DEVFLOW: collect queue health durations and thresholds (#1960)

- Environment overrides for devflow health thresholds:
  - `MYRMIDON_DEVFLOW_ENGINEER_IDLE_MS`: idle engineer alert threshold in milliseconds.
  - `MYRMIDON_DEVFLOW_REVIEW_QUEUE_MS`: review queue age alert threshold in milliseconds.
  - `MYRMIDON_DEVFLOW_RED_CI_MS`: red CI alert threshold in milliseconds.

## changelog-ru

### DEVFLOW: сбор показателей здоровья очередей и пороговые значения (#1960)

- Переменные окружения для порогов здоровья devflow:
  - `MYRMIDON_DEVFLOW_ENGINEER_IDLE_MS`: порог оповещения о простое инженера в миллисекундах.
  - `MYRMIDON_DEVFLOW_REVIEW_QUEUE_MS`: порог возраста очереди ревью в миллисекундах.
  - `MYRMIDON_DEVFLOW_RED_CI_MS`: порог оповещения о красном CI в миллисекундах.
