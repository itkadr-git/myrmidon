## divergence-new

<!-- after: 1.6.4 — AUTONOMY-DELETE: исполнение класса `delete` на DELETE-маршрутах задач -->

### 1.6.2 — AUTONOMY-MATRIX: deploy and merge action enforcement

| ID | Что изменено | Файлы | Зачем | Тесты | Когда снимать | Ссылка |
|---|---|---|---|---|---|---|
| 1.6.2-AUTONOMY-DEPLOY | Класс `deploy` матрицы автономии применяется на `POST /api/myrmidon/deploy-jobs` и `POST /api/myrmidon/maintenance`: шлюз срабатывает до проверки администратора и по роли вызывающего агента отвечает 403 `autonomy_forbidden` (forbidden) или 403 `autonomy_approval_required` (approval_required; удержания действия у board-маршрута пока нет). Доска (не агент) под матрицу не попадает. Заводское умолчание `deploy` изменено с `allowed` на `approval_required`; миграция при чтении: если хранимый документ имел `deploy: allowed` без явных правил для deploy — значение поднимается до `approval_required`. | Наши файлы `server/src/myrmidon/autonomy/deploy-class.ts`, `packages/shared/src/myrmidon-autonomy.ts` (дефолт), `server/src/myrmidon/autonomy/store.ts` (миграция) и `store-migration.myrmidon.test.ts`; в наших маршрутах `server/src/myrmidon/deploy-jobs/routes.ts` и `server/src/myrmidon/maintenance/routes.ts` по одному вызову с маркером `myrmidon(1.6-AUTONOMY)`; свои строки в `SETTINGS.md` и гайды `guides/autonomy-deploy-merge.{en,ru}.md` | 1.6 AUTONOMY-MATRIX: матрица должна решать, что агент может запустить сам; выкат и обслуживание были вне её; дефолт deploy изменён по решению владельца «выкат на бой — только человек» | Оба `autonomy.myrmidon.test.ts` гоняют маршруты через настоящий шлюз: forbidden и approval_required отказывают с нужным кодом и не доходят до сервиса, allowed проходит шлюз, администратор экземпляра матрицей не ограничен; `store-migration.myrmidon.test.ts` проверяет подъём дефолта deploy при чтении | Никогда, наше поведение. Уходит вместе с матрицей автономии | (этот PR) |

## settings-en-new

<!-- after: 1.6 — AUTONOMY-MATRIX (Part A: matrix, enforcement, regulations API) -->

### 1.6.2 — AUTONOMY-MATRIX deploy and merge action classes

Extension of the autonomy matrix to enforce deploy and merge actions. The system now
checks the autonomy matrix for `deploy` and `merge` action classes before allowing
deployment and merge operations.

- `deploy` action class: Controls deployment operations and maintenance mode transitions
- `merge` action class: Controls pull request merge operations (future functionality)

By default, the `deploy` action class is set to `approval_required` for all roles,
meaning that any deployment or maintenance operation initiated by an agent will
require explicit approval unless specifically allowed in the matrix configuration.

The following routes now enforce the `deploy` action class:
- `POST /api/myrmidon/deploy-jobs` - Initiates a deployment job
- `POST /api/myrmidon/maintenance` - Enters maintenance mode

Enforcement is implemented through the autonomy gate (`dbAutonomyGate`) which checks
the matrix before allowing the operation to proceed.

## settings-ru-new

<!-- after: 1.6.3 — PROMPT-BUDGET C: рекомендации по оптимизации промпта и глубокий разбор -->

### 1.6.2 — AUTONOMY-MATRIX: класс действия deploy

Ни переменной окружения, ни новой настройки: существующая матрица автономии (Company Settings, Autonomy)
теперь отвечает и за `POST /api/myrmidon/deploy-jobs` и `POST /api/myrmidon/maintenance`. Агент, чья роль
для `deploy` стоит в `forbidden` или `approval_required`, получает 403 (`autonomy_forbidden` /
`autonomy_approval_required`); пользователи доски под матрицу не попадают. Заводское умолчание остаётся
`allowed`. Руководство: [autonomy-deploy-merge.ru.md](guides/autonomy-deploy-merge.ru.md).
