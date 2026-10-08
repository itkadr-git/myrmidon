## divergence-new

<!-- after: 1.6.4 — AUTONOMY-DELETE: исполнение класса `delete` на DELETE-маршрутах задач -->

### 1.6.2 — AUTONOMY-MATRIX: deploy and merge action enforcement

| ID | Что изменено | Файлы | Зачем | Тесты | Когда снимать | Ссылка |
|---|---|---|---|---|---|---|
| 1.6.2-AUTONOMY-DEPLOY | Класс `deploy` матрицы автономии применяется на `POST /api/myrmidon/deploy-jobs` и `POST /api/myrmidon/maintenance`: шлюз срабатывает до проверки администратора и по роли вызывающего агента отвечает 403 `autonomy_forbidden` (forbidden) или 403 `autonomy_approval_required` (approval_required; удержания действия у board-маршрута пока нет). Доска (не агент) под матрицу не попадает. Второй класс этой же точки — `merge`: он исполняется в шлюзе инструментов (см. строку 1.6-AUTONOMY-GW), поэтому оба класса закрыты в этом выпуске. Заводское умолчание `deploy` изменено с `allowed` на `approval_required`; миграция при чтении: если хранимый документ имел `deploy: allowed` без явных правил для deploy — значение поднимается до `approval_required`. | Наши файлы `server/src/myrmidon/autonomy/deploy-class.ts` (единственная точка проверки: делегирует в `autonomyGate.assertAllowed`, чтобы вердикт и форма ответа резолвились ровно тем же кодом, что и на остальных точках действия), `packages/shared/src/myrmidon-autonomy.ts` (дефолт), `server/src/myrmidon/autonomy/store.ts` (миграция) и `store-migration.myrmidon.test.ts`; в наших маршрутах `server/src/myrmidon/deploy-jobs/routes.ts` и `server/src/myrmidon/maintenance/routes.ts` по одному вызову с маркером `myrmidon(1.6-AUTONOMY)`; свои строки в `SETTINGS.md`/`SETTINGS.ru.md` и гайды `guides/autonomy-deploy-merge.{md,ru.md}` | 1.6 AUTONOMY-MATRIX: матрица должна решать, что агент может запустить сам; выкат и обслуживание были вне её; дефолт deploy изменён по решению владельца «выкат на бой — только человек» | Оба `autonomy.myrmidon.test.ts` гоняют маршруты через настоящий шлюз: forbidden и approval_required отказывают с нужным кодом и не доходят до сервиса, allowed проходит шлюз, администратор экземпляра матрицей не ограничен; `store-migration.myrmidon.test.ts` проверяет подъём дефолта deploy при чтении; сквозной тест «запрещено даже по инструкции» (`routes.myrmidon.test.ts`, `resolver.myrmidon.test.ts`) покрывает оба класса — deploy и merge — и показывает, что инструкции вызывающего не участвуют в вердикте | Никогда, наше поведение. Уходит вместе с матрицей автономии | (этот PR) |

## settings-en-new

<!-- after: 1.6 — AUTONOMY-MATRIX (Part A: matrix, enforcement, regulations API) -->

### 1.6.2 — AUTONOMY-MATRIX deploy and merge action classes

Extension of the autonomy matrix to enforce deploy and merge actions. The system now
checks the autonomy matrix for `deploy` and `merge` action classes before allowing
deployment and merge operations.

- `merge` action class: Controls pull request merge operations — enforced in the
  tool gateway for agent tool calls (see the gateway half of the change)
- `deploy` action class: Controls deployment operations and maintenance mode transitions

By default, the `deploy` action class is set to `approval_required` for all roles,
meaning that any deployment or maintenance operation initiated by an agent will
require explicit approval unless specifically allowed in the matrix configuration.

The following routes now enforce the `deploy` action class:
- `POST /api/myrmidon/deploy-jobs` - Initiates a deployment job
- `POST /api/myrmidon/maintenance` - Enters maintenance mode

Enforcement is implemented through `assertDeployClassAllowed`
(`server/src/myrmidon/autonomy/deploy-class.ts`), which resolves the stored matrix
through the autonomy gate (`autonomyGate.assertAllowed`) for the calling agent
before the route does anything else.

## settings-ru-new

<!-- after: 1.6.3 — PROMPT-BUDGET C: рекомендации по оптимизации промпта и глубокий разбор -->

### 1.6.2 — AUTONOMY-MATRIX: класс действия deploy

Ни переменной окружения, ни новой настройки: существующая матрица автономии (Company Settings, Autonomy)
теперь отвечает и за `POST /api/myrmidon/deploy-jobs` и `POST /api/myrmidon/maintenance`. Агент, чья роль
для `deploy` стоит в `forbidden` или `approval_required`, получает 403 (`autonomy_forbidden` /
`autonomy_approval_required`); пользователи доски под матрицу не попадают. Заводское умолчание `deploy`
изменено с `allowed` на `approval_required`, а хранимый `deploy: allowed` без явных правил для deploy
поднимается до `approval_required` при чтении. Руководство:
[autonomy-deploy-merge.ru.md](guides/autonomy-deploy-merge.ru.md).

## divergence-replace

<!-- section: 1.6 — WIKI-CORTEX: регламенты компании в вики -->

| 1.6-AUTONOMY-A | Модуль autonomy (Part A): матрица «роль × класс действия» → allowed/approval_required/forbidden + регламенты ролей с ревизиями draft→approved и change log. Контракт в `packages/shared/src/myrmidon-autonomy.ts` (типы + zod + резолвер `resolveAutonomy`, специфичность agent > role > default). Хранение без миграции: `instance_settings.general.myrmidonAutonomy` (JSON-паттерн instance-settings); сохранение ключа при вендорских записях `general` через `preserveAutonomyGeneralKey`. REST: `GET /api/myrmidon/autonomy` (+ `?companyId=`), `PATCH .../matrix` (expectedVersion → 409 при рассинхроне), `POST .../regulations`, `PATCH .../regulations/:id` (новая ревизия), `POST .../regulations/:id/approve`, `POST .../regulations/:id/revisions/:rev/restore`; change log — строки `myrmidon.autonomy.*` из activity_log, готовым массивом в GET. Фабричный дефолт: все клетки allowed, кроме `deploy` — `approval_required` (нулевое изменение поведения остальных классов до первой правки оператором; расхождение с дизайн-заметкой фиксировано в PR Thinking Path; дефолт `deploy` изменён строкой 1.6.2-AUTONOMY-DEPLOY). Шлюз enforcement: `autonomyGate` в gate.ts для точки действия | Наши файлы: `packages/shared/src/myrmidon-autonomy.ts`, `server/src/myrmidon/autonomy/**` (store, service, routes, gate, index, 3 теста `*.myrmidon.test.ts`); в вендоре помечены `myrmidon(1.6-AUTONOMY)`: `packages/shared/src/index.ts` (одна строка экспорта), `server/src/app.ts` (импорт + монтирование), `server/src/services/instance-settings.ts` (импорт + preserve-строка) | Эпик 1.6 AUTONOMY-MATRIX: автономия решается в точке действия, не в промптах; регламенты живут в собственном JSON-хранилище матрицы (вики-ссылка — additive-поле позже) | `server/src/myrmidon/autonomy/{resolver,service,routes}.myrmidon.test.ts` (29 тестов: forbidden отклонён несмотря на инструкции; approval_required ждёт карточку; allowed проходит; ревизии/rollback; 409 на версии; авторизация board/company) | Никогда, наше поведение. Снятие: удалить autonomy-дерево, строку экспорта shared, две строки маркера и секции SETTINGS/DIVERGENCE | (этот PR) |
