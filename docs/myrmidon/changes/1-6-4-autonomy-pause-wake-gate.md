## divergence-new

<!-- after: 1.6 — WIKI-CORTEX: регламенты компании в вики -->

### 1.6.2 — AUTONOMY-MATRIX: исполнение pause_wake_agents на маршрутах pause/resume/wakeup

| ID | Что изменено | Файлы | Зачем | Тесты | Когда снимать | Ссылка |
|---|---|---|---|---|---|---|
| 1.6.2-AUTONOMY-PAUSE-WAKE | Вызов `dbAutonomyGate(db).assertAllowed(req, "pause_wake_agents")` в трёх маршрутах `POST /agents/:id/pause`, `/resume`, `/wakeup` — только когда вызывающий агент действует на другого агента (self не считается). Вердикт `approval_required` трактуется как запрет с кодом `autonomy_approval_required` (держание действия — отдельная задача). Доска и админ матрице не подчиняются. | `server/src/routes/agents.ts` (три строки с маркером `myrmidon(1.6.2)`), `server/src/myrmidon/autonomy/gate.ts` (экспорт `AUTONOMY_APPROVAL_REQUIRED_CODE`), `server/src/myrmidon/autonomy/routes-1.6.2.myrmidon.test.ts` (5 тестов: forbidden → 403; allowed → проходит; доска → проходит; сам себя → проходит; approval_required → 403), `docs/myrmidon/guides/autonomy-pause-wake-enforcement.md` и `.ru.md`, строка в `docs/myrmidon/SETTINGS.md` | Эпик 1.6 AUTONOMY-MATRIX: агент не может поставить на паузу/возобновить/разбудить другого агента, если матрица его роли это запрещает — что бы ни было в его инструкциях | `server/src/myrmidon/autonomy/routes-1.6.2.myrmidon.test.ts` (5 тестов) | Никогда, наше поведение. Снятие: удалить три `if`-блока из `agents.ts`, экспорт из `gate.ts`, тест и обе доки | OPE-4133 |

## settings-en-append

<!-- after-line: in the UI takes effect without a restart (no env override, no new settings keys). -->

1.6.2 enforcement: `POST /agents/:id/pause`, `POST /agents/:id/resume`, and
`POST /agents/:id/wakeup` call `dbAutonomyGate(db).assertAllowed(req, "pause_wake_agents")`
when the caller is an agent acting on another agent (self-actions are not gated).
The verdict `approval_required` is denied with 403 `autonomy_approval_required`
until the held-action half ships (a separate task). Board and admin callers are
not subject to the matrix.
