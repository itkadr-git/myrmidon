## changelog-en

### Issue list agent defaults: agents get compact, capped, description-free list responses (F16, part A)

- `GET /api/companies/:companyId/issues` used to answer 1.5–4 MB to a bare agent request, because the full response carries every issue's `description`. For an actor of type `agent` the endpoint now applies agent-oriented defaults: a request without `view` is answered as `view=compact`, `limit` defaults to 200, and the compact body omits `description` (the agent fetches the body of the one issue it needs via the detail endpoint).
- An agent's explicit `limit` above 500 is refused with 400 and a pagination hint (`offset` / `afterId`) instead of being silently clamped. The full view stays reachable through an explicit `view=full` together with an explicit `limit <= 100`; `view=full` without a limit is refused (the agent default of 200 already exceeds the full-view cap).
- The behaviour is gated by the instance setting `issuesListAgentDefaults` in `instance_settings.general` (changed without a deploy). The key is absent on instances that never toggled it, and absent means ON (defect-fix on). `{enabled: false}` restores the pre-feature agent behaviour byte-for-byte.
- The board actor is untouched: a bare board request keeps the full response, `limit=1000` is clamped as before, and `view=full` stays a 400 (the UI compatibility contract).

## changelog-ru

### Умолчания списка задач для агентов: компактные, ограниченные ответы без description (F16, часть A)

- `GET /api/companies/:companyId/issues` отдавал ботам 1,5–4 МБ на запрос без параметров, потому что полный ответ несёт `description` каждой задачи. Для актёра типа `agent` эндпоинт теперь применяет агентские умолчания: запрос без `view` отвечается как `view=compact`, `limit` по умолчанию 200, а компактное тело не содержит `description` (тело конкретной задачи агент забирает детальным эндпоинтом).
- Явный `limit` агента выше 500 отклоняется с 400 и подсказкой про пагинацию (`offset` / `afterId`) вместо молчаливого клэмпа. Полный ответ остаётся доступен через явный `view=full` вместе с явным `limit <= 100`; `view=full` без limit отклоняется (агентский дефолт 200 уже превышает потолок full-view).
- Поведение стоит за настройкой экземпляра `issuesListAgentDefaults` в `instance_settings.general` (меняется без выката). Ключ отсутствует на инстансах, где его не трогали, и отсутствие означает «включено» (дефект-фикс включён). `{enabled: false}` возвращает поведение до исправления байт-в-байт.
- Актёр доски не затронут: запрос доски без параметров по-прежнему получает полный ответ, `limit=1000` клэмпится как раньше, а `view=full` остаётся 400 (совместимость UI).

## divergence-new

<!-- after: 1.6.4 — AUTONOMY-DELETE: исполнение класса `delete` на DELETE-маршрутах задач -->

### 1.6.5 — F16 ч.A: умолчания списка задач для актёра-агента

| ID | Что меняем | Файлы | Зачем | Тесты | Когда снимать | Ссылка |
|---|---|---|---|---|---|---|
| F16 | Умолчания `GET /api/companies/:companyId/issues` для актёра-агента: без `view` ответ — compact, `limit` по умолчанию 200 (явный >500 — 400 с подсказкой про пагинацию `offset`/`afterId` вместо клэмпа), в compact-ответе агента нет поля `description`; полный ответ — только явный `view=full` с явным `limit <= 100` (без limit — 400, т.к. агентский дефолт 200 больше потолка). Поведение доски не меняется (bare → full, `limit=1000` клэмп, `view=full` → 400). Гейт — настройка `issuesListAgentDefaults` в `instance_settings.general` (absent = вкл, `{enabled: false}` = поведение до фикса байт-в-байт); чтение настройки — в точке обработчика листинга через `instanceSettingsService(db).getGeneral()`. Ключ кэша/ETag листинга включает состояние настройки — тела с/без `description` не смешиваются при одинаковом query | Наши файлы: `packages/shared/src/myrmidon-issue-list-agent-defaults.ts` (контракт: схема, ключ, константы лимитов, резолвер), `server/src/__tests__/issue-list-agent-defaults.myrmidon.test.ts`; в вендоре помечены `myrmidon(F16)`: `packages/shared/src/index.ts` (строка экспорта), `packages/shared/src/validators/instance.ts` (поле схемы), `packages/shared/src/types/instance.ts` (поле типа), `server/src/routes/issues.ts` (импорт, чтение настройки, дефолт лимита, валидация view/limit, признак в ключе кэша, урезание `description` в `toCompactIssue`), `server/src/routes/openapi.ts` (описание `view`) | Боты без параметров получали 1,5–4 МБ на список задач; агентам достаточно компактного ряда, тело нужной задачи забирается детальным эндпоинтом (эпик F16, часть A — сервер; часть B — UI/nginx) | `server/src/__tests__/issue-list-agent-defaults.myrmidon.test.ts` (агент без view → compact/200 строк/без description; limit=1000 → 400 с подсказкой; view=full&limit=50 → 200 с description; view=full&limit=200 → 400; выключенная настройка — поведение как раньше; доска — регресс UI; ETag/304 и разделение ключей при переключении настройки) | Никогда, наше поведение (дефект-фикс). Снять: убрать строки с маркером `myrmidon(F16)`, контракт `packages/shared/src/myrmidon-issue-list-agent-defaults.ts` и тест | (этот PR) |

## settings-en-new

<!-- after: 1.6.4 — AUTONOMY-DELETE: matrix enforcement tests and route mapping -->

### 1.6.5 — F16 A: issue list agent defaults

The defaults of `GET /api/companies/:companyId/issues` for an actor of type `agent`.
Stored in `instance_settings.general.issuesListAgentDefaults`; read at the list route,
applied without a restart. There is no environment variable and no dedicated route —
the value is changed by an operator write to the general settings row.

| Variable | Function | Default | What it does | How to disable / special |
|---|---|---|---|---|
| `issuesListAgentDefaults.enabled` | F16 | `true` (the key is absent until first toggled, and absent means `true`) | Turns the agent defaults of the issue list on: a bare agent request is answered as `view=compact`, `limit` defaults to 200 with a maximum of 500 (above — 400 with a pagination hint), the compact body omits `description`, and the full view needs an explicit `view=full&limit<=100` | `{ "enabled": false }` restores the pre-feature agent behaviour byte-for-byte; the board actor is unaffected in both states |

## settings-ru-new

### 1.6.5 — F16 A: умолчания списка задач для агентов

Умолчания `GET /api/companies/:companyId/issues` для актёра типа `agent`.
Хранятся в `instance_settings.general.issuesListAgentDefaults`; читаются в обработчике
листинга, применяются без перезапуска. Переменной окружения и отдельного маршрута нет —
значение меняется операторской записью в строку общих настроек.

| Переменная | Функция | Умолчание | Что делает | Как отключить / особенности |
|---|---|---|---|---|
| `issuesListAgentDefaults.enabled` | F16 | `true` (ключа нет до первой записи, и отсутствие означает `true`) | Включает агентские умолчания списка задач: запрос агента без `view` отвечается как `view=compact`, `limit` по умолчанию 200 с максимумом 500 (больше — 400 с подсказкой про пагинацию), компактное тело без `description`, полный ответ — только явный `view=full&limit<=100` | `{ "enabled": false }` возвращает поведение до фикса байт-в-байт; актёр доски не затрагивается ни в одном из состояний |
