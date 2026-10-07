## changelog-en

### STARTUP-WATCHDOG-PAUSED: a paused watchdog agent no longer stops the board; the predeploy copy uses the production secrets key

- `server/src/services/task-watchdogs.ts` — when waking the watchdog agent
  fails with 409 ("Agent is not invokable in its current state": paused or
  disabled), that watchdog is skipped with a warning (counted as `skipped`),
  and the remaining watchdogs are processed as before. Other errors still throw.
- `server/src/index.ts` — the startup `reconcileTaskWatchdogs` call is
  best-effort: an error is logged as a warning and startup continues. Before,
  a restart with a paused watchdog agent ended in `startup heartbeat recovery
  failed` / `Paperclip server failed to start`.
- `scripts/myrmidon/deploy/predeploy-board-check.sh`,
  `scripts/myrmidon/deploy/deploy.env.example` — new optional
  `MYRMIDON_PREDEPLOY_MASTER_KEY_FILE`: that single file (production
  `instances/default/secrets/master.key`) is mounted read-only into the
  throwaway board, with `PAPERCLIP_SECRETS_MASTER_KEY_FILE` set. Without it the
  copy creates its own key (stored secrets fail with "Secret decryption
  failed") and the check prints a WARNING. The key is never printed.
- Tests: `server/src/__tests__/task-watchdogs-scheduler.test.ts`,
  `scripts/myrmidon/deploy/predeploy-board-check.test.mjs`.

## changelog-ru

### STARTUP-WATCHDOG-PAUSED: приостановленный агент-сторож больше не останавливает доску; предвыкатная копия использует боевой ключ секретов

- `server/src/services/task-watchdogs.ts` — если побудка агента-сторожа даёт
  409 («Agent is not invokable in its current state»: пауза или выключен), этот
  сторож пропускается с предупреждением (считается `skipped`), остальные
  обрабатываются как раньше. Прочие ошибки по-прежнему бросаются.
- `server/src/index.ts` — вызов `reconcileTaskWatchdogs` при старте не
  критичен: ошибка пишется предупреждением, старт продолжается. Раньше
  перезапуск при приостановленном агенте-сторожe заканчивался
  `startup heartbeat recovery failed` / `Paperclip server failed to start`.
- `scripts/myrmidon/deploy/predeploy-board-check.sh`,
  `scripts/myrmidon/deploy/deploy.env.example` — новая необязательная
  `MYRMIDON_PREDEPLOY_MASTER_KEY_FILE`: этот один файл (боевой
  `instances/default/secrets/master.key`) монтируется в контейнер копии на
  чтение, задаётся `PAPERCLIP_SECRETS_MASTER_KEY_FILE`. Без неё копия создаёт
  свой ключ (секреты не расшифровываются — «Secret decryption failed»), проверка
  печатает WARNING. Ключ нигде не печатается.
- Тесты: `server/src/__tests__/task-watchdogs-scheduler.test.ts`,
  `scripts/myrmidon/deploy/predeploy-board-check.test.mjs`.
