## changelog-en

### PREDEPLOY-DB-CHECK: the predeploy token file is checked with the other inputs of the step, before the first docker call

- `scripts/myrmidon/deploy/predeploy-board-check.sh` — when
  `MYRMIDON_PREDEPLOY_TOKEN_FILE` (optional) is set, the file is validated next
  to the other step inputs (`MYRMIDON_PREDEPLOY_POSTGRES_IMAGE`,
  `*_BOARD_ENV_FILE`), BEFORE the first docker call: "set but not a file",
  "set but not readable" and "set but empty" each stop the deploy with a
  message naming the input. Before this, only the setting being filled was
  checked, and a set-but-unreachable file surfaced later, in
  `auth_header_args` on the health-wait step — after Postgres was up and the
  dump restored. The token stays optional: without it the route walk gets
  401/403 and that is still a warning.
- `scripts/myrmidon/deploy/deploy.env.example` — a comment on the setting.
- Tests: `scripts/myrmidon/deploy/predeploy-board-check.test.mjs` — the 401/403
  case now uses a real token file (its previous `/nonexistent/token`
  configuration is exactly the case that moved earlier), plus a new case: a
  missing file, a directory, an empty file and (only when not run as root) an
  unreadable file stop the deploy and docker is never called.

## changelog-ru

### PREDEPLOY-DB-CHECK: токен-файл predeploy-проверки проверяется вместе с остальными входами шага, до первого вызова docker

- `scripts/myrmidon/deploy/predeploy-board-check.sh` — когда задан
  `MYRMIDON_PREDEPLOY_TOKEN_FILE` (необязательный), файл проверяется рядом с
  остальными входами шага (`MYRMIDON_PREDEPLOY_POSTGRES_IMAGE`,
  `*_BOARD_ENV_FILE`), ДО первого вызова docker: «задан, но не файл», «задан,
  но не читается» и «задан, но пуст» — каждый случай останавливает выкат
  сообщением, называющим вход. Раньше проверялся только факт «настройка
  заполнена», и заданный-но-недоступный файл всплывал позже, в
  `auth_header_args` на шаге ожидания health — после подъёма Postgres и
  восстановления дампа. Токен остаётся необязательным: без него обход маршрутов
  даёт 401/403 и это по-прежнему предупреждение.
- `scripts/myrmidon/deploy/deploy.env.example` — комментарий к настройке.
- Тесты: `scripts/myrmidon/deploy/predeploy-board-check.test.mjs` — кейс
  401/403 теперь с реальным токен-файлом (его прежняя конфигурация
  `/nonexistent/token` — ровно тот случай, что переехал раньше), плюс новый
  кейс: отсутствующий файл, каталог, пустой файл и (только не под root)
  нечитаемый файл — выкат останавливается, docker не вызывается.
