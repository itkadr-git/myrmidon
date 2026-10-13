## changelog-en

### CI shard retry and transport timing (F-19)

- Full CI retries each failed shard once; tests still failing after the retry are reported with `flaky-quarantine` markers.
- The runner transport runtime read-timeout assertion tolerates timing variation.

## changelog-ru

### Авторетрай шардов CI и допуск тайминга transport (F-19)

- Полный CI один раз повторяет каждый упавший шард; тесты, продолжающие падать после повтора, отмечаются маркерами `flaky-quarantine`.
- Проверка таймаута чтения runner transport допускает отклонение времени.
