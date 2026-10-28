## changelog-en

### Devflow health alert threshold overrides

- Deployment environment overrides for DEVFLOW health alert thresholds:
  - `MYRMIDON_DEVFLOW_ENGINEER_IDLE_MS`: override threshold for engineer idle duration alert (default: 3600000 ms).
  - `MYRMIDON_DEVFLOW_REVIEW_QUEUE_MS`: override threshold for review queue age alert (default: 86400000 ms).
  - `MYRMIDON_DEVFLOW_RED_CI_MS`: override threshold for red CI duration alert (default: 3600000 ms).

## changelog-ru

### Переопределения порогов алертов здоровья devflow

- Переменные окружения развёртывания для переопределения порогов здоровья DEVFLOW:
  - `MYRMIDON_DEVFLOW_ENGINEER_IDLE_MS`: порог алерта простоя инженера (по умолчанию: 3600000 мс).
  - `MYRMIDON_DEVFLOW_REVIEW_QUEUE_MS`: порог алерта возраста очереди ревью (по умолчанию: 86400000 мс).
  - `MYRMIDON_DEVFLOW_RED_CI_MS`: порог алерта длительности красного CI (по умолчанию: 3600000 мс).
