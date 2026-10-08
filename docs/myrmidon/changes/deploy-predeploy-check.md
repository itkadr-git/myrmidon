## changelog-en
### The board image is proven on a copy of the production database before the window; rollback without a live board (PREDEPLOY-DB-CHECK)

- `scripts/myrmidon/deploy/predeploy-board-check.sh` (new): before the
  maintenance window the production dump is restored into a throwaway Postgres
  and the new board image runs next to the new dockergate on an isolated
  network; it waits for `/api/health` `ok` with the image's version, walks the
  attention list and main routes, and any failure stops the deploy with
  nothing changed on production (the 1.6.3 crash on production data inside
  the window is why it exists).
- deploy.sh step 3b runs it pre-window; changed components roll out BEFORE
  the board switch; rollback of the board happens only if its image line was
  written.
- rollback.sh no longer needs the board API to enter/leave maintenance — a
  rollback usually runs BECAUSE the board is down; the image switch and health
  check still decide. `maintenance_enter` reports a failed enter honestly.
- New `MYRMIDON_PREDEPLOY_*` settings (check on by default); tests walk the
  whole throwaway stack against fake `docker`/`curl`.
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
