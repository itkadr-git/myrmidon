## changelog-en

### GUARD-RETURN: return code tasks on noncoding roles (#2036)

- Environment overrides for guard-return and devflow:
  - `MYRMIDON_GUARD_RETURN_INTERVAL_SEC`: interval in seconds for the periodic guard-return sweep (default 300).
  - `MYRMIDON_DEVFLOW_CODE_TASKS_NONCODING_MS`: threshold in milliseconds for devflow alert on code tasks held by non-coding roles (default 1800000).

## changelog-ru

### GUARD-RETURN: возврат задач с кодом на не-инженерных ролях (#2036)

- Переменные окружения для guard-return и devflow:
  - `MYRMIDON_GUARD_RETURN_INTERVAL_SEC`: интервал в секундах для периодического sweep возврата задач (по умолчанию 300).
  - `MYRMIDON_DEVFLOW_CODE_TASKS_NONCODING_MS`: порог в миллисекундах для devflow-алерта задач с кодом на не-инженерных ролях (по умолчанию 1800000).
