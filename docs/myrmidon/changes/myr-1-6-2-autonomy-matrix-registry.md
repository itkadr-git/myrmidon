## divergence-new

<!-- after: 1.6.2 — AUTONOMY-MATRIX (instructions change control) -->

### 1.6.2 — AUTONOMY-MATRIX (execution point registry)

| ID | Что изменено | Файлы | Зачем | Тесты | Когда снимать | Ссылка |
|---|---|---|---|---|---|---|
| 1.6.2-AUTONOMY-REGISTRY | Реестр точек исполнения матрицы автономии и сторож против его расхождения с кодом. `server/src/myrmidon/autonomy/registry.ts` перечисляет, где какой класс действий реально исполняется: маршрут/инструмент, файл-стык и вызываемая функция гейта (`assertAllowed` или `decide`). Класс, который матрица знает, но ни один стык на этом дереве ещё не исполняет, лежит в `PENDING_ENFORCEMENT` с причиной (`pause_wake_agents`, `merge`, `deploy`, `external_message`); `other` и `spend_above_threshold` исключены (`REGISTRY_EXEMPT_CLASSES`). Тест `registry.myrmidon.test.ts` читает файл-стык с диска и сопоставляет `call(req, "<класс>")`: удалить вызов гейта из подключённого маршрута — тест краснеет; класс матрицы, не попавший ни в реестр, ни в список ожидающих, тест тоже роняет, как и пересечение списков или класс вне `AUTONOMY_ACTION_CLASSES`. Отказ гейта держат два теста: `gate-deny.myrmidon.test.ts` (юнит самого гейта) и `server/src/routes/agents-autonomy-e2e.myrmidon.test.ts` (маршрутный сквозной — настоящий express-маршрут, настоящий гейт и настоящий документ матрицы, подменяется только фабрика, читающая БД; агент, чьи инструкции требуют запрещённого `change_instructions`, получает 403 и бандл не переписывается): `forbidden` → 403 с кодом `autonomy_forbidden` (с классом и ролью в деталях), `allowed` проходит, не-агент (доска) матрице не подчиняется | Наши файлы: `server/src/myrmidon/autonomy/registry.ts`, `server/src/myrmidon/autonomy/registry.myrmidon.test.ts`, `server/src/myrmidon/autonomy/gate-deny.myrmidon.test.ts`, `server/src/routes/agents-autonomy-e2e.myrmidon.test.ts`, `docs/myrmidon/guides/autonomy-matrix.md` (EN), `docs/myrmidon/guides/autonomy-matrix.ru.md` (RU), строка в `docs/myrmidon/SETTINGS.md`. Вендорские файлы не тронуты: реестр — справочник и сторож, сами стыки живут в своих записях (`1.6.2-AUTONOMY-CHANGE-INSTRUCTIONS`, delete-PR) | Эпик 1.6 AUTONOMY-MATRIX: матрица хранится и редактируется, но не было ни ответа «какие классы где исполняются», ни теста, который ловит класс без точки исполнения; реестр даёт читаемый ответ, сторож — против молчаливого расхождения реестра с кодом и против вызова гейта, удалённого из маршрута | `server/src/myrmidon/autonomy/registry.myrmidon.test.ts` (покрытие классов матрицы, диспозиция реестр/ожидание, непересечение списков, чтение стыка из исходника — красный при удалении вызова гейта, причина у каждого ожидающего класса) и два отказных теста — юнит `server/src/myrmidon/autonomy/gate-deny.myrmidon.test.ts` (403 `autonomy_forbidden` с классом и ролью; `allowed` проходит; доска вне матрицы) и маршрутный `server/src/routes/agents-autonomy-e2e.myrmidon.test.ts` (403 через настоящий маршрут, состояние не изменено) | Никогда, наше поведение. Снятие: удалить `registry.ts`, сторож реестра, оба отказных теста, гайды EN/RU и строку в SETTINGS; сами стыки снимаются своими записями | (этот PR) |

## settings-en-new

<!-- after: 1.6 — AUTONOMY-MATRIX (Part A: matrix, enforcement, regulations API) -->

### 1.6 — AUTONOMY-MATRIX (execution point registry)

`server/src/myrmidon/autonomy/registry.ts` is the readable answer to "where is
this action class enforced?". Each entry names a route or tool, the repo-relative
file that holds the gate call, and the gate function the seam calls
(`assertAllowed` or `decide`).

`server/src/myrmidon/autonomy/registry.myrmidon.test.ts` reads every seam back out
of the source and matches `call(req, "<class>")`, so deleting the gate call from a
connected route turns the suite red — the registry cannot drift into a wish list.
It also fails when a class the matrix can hold is in neither the registry nor the
pending list, when the two lists overlap, or when either names a class outside
`AUTONOMY_ACTION_CLASSES`.

A class the matrix defines but no seam enforces on this tree is listed in
`PENDING_ENFORCEMENT` with its reason instead of the registry (today:
`pause_wake_agents`, `merge`, `deploy`, `external_message`); `other` and
`spend_above_threshold` are exempt (`REGISTRY_EXEMPT_CLASSES`). The same table is
mirrored in `docs/myrmidon/guides/autonomy-matrix.md` (EN) and `.ru.md` (RU).

| Action class | Execution point | Source seam |
|---|---|---|
| `delete` | `DELETE /api/issues/:id` and the five sibling DELETE routes | `server/src/routes/issues.ts` (`assertAllowed(req, "delete")`) |
| `change_instructions` | `PATCH /api/agents/:id/instructions-path`, `PATCH /api/agents/:id/instructions-bundle`, `DELETE /api/agents/:id/instructions-bundle/file` | `server/src/routes/agents.ts` (`decide(req, "change_instructions")`) |
| `change_instructions` | `POST /api/agents/:id/instructions-revisions/:revisionId/rollback` | `server/src/myrmidon/agent-instructions-revisions/index.ts` (`decide(req, "change_instructions")`) |

No environment variables, no new secrets, nothing to toggle: the registry is a
static map plus its guard test, so a matrix edit needs no restart and no re-read.

Three tests hold the behaviour: `registry.myrmidon.test.ts` reads each seam out of
the source (remove the gate call from a connected route and it goes red),
`gate-deny.myrmidon.test.ts` pins the deny half of the gate itself, and
`server/src/routes/agents-autonomy-e2e.myrmidon.test.ts` drives the real express
route with the real gate and a real matrix document (only the DB-backed factory
is swapped for an in-memory store): an agent caller whose instructions demand a
forbidden `change_instructions` gets 403 `autonomy_forbidden` and the instructions
bundle is not rewritten.

Remove: `registry.ts`, `registry.myrmidon.test.ts`, `gate-deny.myrmidon.test.ts`,
`server/src/routes/agents-autonomy-e2e.myrmidon.test.ts`, the two guide files and
this section (the enforcement seams themselves belong to their own entries above).
