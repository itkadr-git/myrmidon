## changelog-en

### PREDEPLOY-DB-CHECK: the board image is proven on a copy of the production database before the window; the components roll out before the board; rollback without a live board

- `scripts/myrmidon/deploy/predeploy-board-check.sh` (new) — before the
  maintenance window the predeploy dump is restored into a throwaway Postgres
  and the new board image is started next to the NEW dockergate of the same
  release, on its own docker network (no bot container, no production
  dockergate). The check waits for `/api/health` `status: ok` with the version
  and commit of the image and then walks the attention list and the main company
  routes; any failure stops the deploy BEFORE the window with nothing on
  production changed. The 05.10 incident it exists for: the 1.6.3 board started
  fine against the empty CI database and crashed on production DATA (an
  attention card whose key was not a uuid) inside the window.
- `scripts/myrmidon/deploy/deploy.sh` — step 3b runs that check before the
  deploy window marker; the changed release COMPONENTS now roll out inside the
  window BEFORE the board is switched (DOCKERGATE-FIRST), so the board is
  verified against the new dockergate and not the running one (the 1.6.3 board
  never became `ok` against the old dockergate: `route_not_allowed`, and
  dockergate rolled out only after the board check); the all-or-nothing rollback
  rolls the board back only when its image line was actually written.
- `scripts/myrmidon/deploy/rollback.sh` — ROLLBACK-WITHOUT-BOARD: entering and
  leaving maintenance no longer requires the board API to answer. A rollback
  usually runs BECAUSE the board is down; a failed enter/exit is logged loudly
  and the rollback continues, the image switch and the health check still decide.
- `scripts/myrmidon/deploy/lib.sh` — `maintenance_enter` reports an enter that
  did not happen (api: the POST did not answer; hook: the command failed)
  instead of logging `entered` over a failed POST.
- `scripts/myrmidon/deploy/deploy.env.example` — the new `MYRMIDON_PREDEPLOY_*`
  settings; the check is on by default.
- Tests: `scripts/myrmidon/deploy/predeploy-board-check.test.mjs` (new) walks
  the whole throwaway stack against fake `docker`/`curl`; the deploy,
  release-gate, bot-image-rollout, deploy-from-job and tracing harnesses grew
  the pre-window check, the component-before-board order, the board-less
  rollback and the copy-teardown cases.

## changelog-ru

### PREDEPLOY-DB-CHECK: образ доски проверяется на копии боевой базы до окна; компоненты выкатываются до доски; откат без живой доски

- `scripts/myrmidon/deploy/predeploy-board-check.sh` (новый) — до окна
  обслуживания predeploy-дамп разворачивается в одноразовый Postgres, рядом
  поднимается новая доска и НОВЫЙ dockergate того же релиза, в своей сети
  docker (ни контейнеров ботов, ни боевого dockergate на ней нет). Шаг ждёт
  `/api/health` со `status: ok` и версией/коммитом образа, затем обходит список
  внимания и основные маршруты компании; любая ошибка останавливает выкат ДО
  окна, на бою ничего не меняется. Ради случая 05.10: доска 1.6.3 поднялась на
  пустой базе CI, а на боевых ДАННЫХ упала (карточка внимания с ключом вместо
  uuid) уже внутри окна.
- `scripts/myrmidon/deploy/deploy.sh` — шаг 3b запускает эту проверку до
  отметки окна; изменённые КОМПОНЕНТЫ релиза теперь выкатываются внутри окна ДО
  переключения доски (DOCKERGATE-FIRST), поэтому доска проверяется против
  нового dockergate, а не против работающего (доска 1.6.3 не становилась `ok`
  при старом dockergate: `route_not_allowed`, а dockergate выкатывался после
  проверки доски); откат «всё или ничего» возвращает доску только если её
  строка образа действительно была записана.
- `scripts/myrmidon/deploy/rollback.sh` — ROLLBACK-WITHOUT-BOARD: вход в
  обслуживание и выход из него больше не требуют ответа API доски. Откат обычно
  и запускают ПОТОМУ, что доска лежит; неудачный вход/выход пишется громким
  предупреждением, а откат продолжается — исход решают смена образа и проверка
  здоровья.
- `scripts/myrmidon/deploy/lib.sh` — `maintenance_enter` сообщает о входе,
  которого не было (api: POST не ответил; hook: команда упала), вместо записи
  `entered` поверх неудачного POST.
- `scripts/myrmidon/deploy/deploy.env.example` — новые настройки
  `MYRMIDON_PREDEPLOY_*`; проверка включена по умолчанию.
- Тесты: `scripts/myrmidon/deploy/predeploy-board-check.test.mjs` (новый)
  проходит весь одноразовый стек на подставных `docker`/`curl`; наборы deploy,
  release-gate, bot-image-rollout, deploy-from-job и tracing получили случаи
  предоконной проверки, порядка «компоненты до доски», отката без доски и
  снятия копии.
