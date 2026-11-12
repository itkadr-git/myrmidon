# ADR-0052: Словарь permission-режимов и точки enforcement

- Status: proposed
- Date: 2026-11-12
- Deciders: — (спека готовится по поручению OPE-12739; источник — OPE-9803, принятый план rev 2 `da10d775-5a8d-40bb-aded-a20697996e3e`, раздел 3.B)
- Scope: autonomy/permission агентов, execution policy, issue-thread interactions, approvals

## Context

Сегодня права агента регулируются четырьмя независимыми механизмами, каждый со своей точкой
проверки:

1. **Матрица автономии** (1.6-AUTONOMY): роль × класс действия → `allowed / approval_required /
   forbidden` (`packages/shared/src/myrmidon-autonomy.ts`, `server/src/myrmidon/autonomy/`).
2. **Execution policy задачи**: стадии, approvalsNeeded, monitor
   (`packages/shared/src/types/issue.ts:742`, `server/src/services/issue-execution-policy.ts`).
3. **Issue-thread interactions**: `request_confirmation` / `ask_user_questions` /
   `request_checkbox_confirmation` (`server/src/services/issue-thread-interactions.ts`) и
   consent-гейт для мутаций профилей/скиллов
   (`server/src/services/change-consent-gate.ts:117`).
4. **Execution-workspace policy**: где и как выполняется прогон
   (`packages/shared/src/types/workspace-runtime.ts:167-196`,
   `server/src/services/execution-workspace-policy.ts`).

Оператор не может одним решением сказать «этот прогон работает в таком-то режиме
автономности»: степень интерактивности задаётся неявно — инструкциями агента, клетками
матрицы и тем, какие интеракции агент решит создать. Словаря режимов нет.

Прецедент словаря — t3code (Claude Code): `default / acceptEdits / plan / bypassPermissions`.
В этом ADR словарь адаптирован под доску: `supervised / auto_edits / auto / full` (режим
`plan` из t3code здесь соответствует штатному контракту «план → request_confirmation →
реализация» и отдельным режимом не является).

Это ADR-спека: **кода в этой задаче нет**. Каждая позиция помечена точкой enforcement
(файл:строка) или «не покрыто, нужен код». ADR-0001 (п. 2) запрещает ссылаться на
несуществующий код — все новые точки ниже явно помечены как требующие реализации.

## Decision

### 1. Словарь режимов

Четыре режима, по возрастанию автономности:

| Режим | Что разрешено без вопроса | Что спрашивает |
|---|---|---|
| `supervised` | обратимые действия внутри утверждённого плана: чтение, локальные тесты, поиск, черновики в задаче | план (`request_confirmation`), каждое изменение кода в рабочей копии сверх плана, каждый вызов класса `approval_required` |
| `auto_edits` | всё из `supervised` + обратимые правки файлов в execution workspace (edit/create/delete в рабочей копии, коммиты в свою ветку) | план, вызовы класса `approval_required`, всё за границей workspace (push в чужие ветки, внешние сервисы) |
| `auto` | всё из `auto_edits` + вызовы класса `approval_required`, помеченные `modeLiftable: true` (см. «Маппинг»), + push в свою ветку и открытие PR | план, необратимые и внешние действия из списка «всегда подтверждается» |
| `full` | всё из `auto`, кроме списка «всегда подтверждается» | только список «всегда подтверждается» |

Режим **не даёт** (ни в одном режиме):

- не отменяет вопросы агент → человек: `ask_user_questions` по существенной
  неопределённости задачи работает во всех режимах одинаково. Режим регулирует
  *подтверждение действий*, а не *вопросы по существу работы*;
- не поднимает клетку `forbidden` матрицы автономии: forbidden остаётся 403 во всех
  режимах (`server/src/services/tool-gateway.ts:10747`);
- не отменяет стадии review/approvals execution policy задачи и вердикт ревьюера;
- не отменяет список «всегда подтверждается» (ниже);
- не меняет execution-workspace policy: стратегию workspace, network egress, изоляцию.

### 2. Уровни задания режима и cap

- **Прогон/задача**: явный выбор режима на задаче (поле рядом с execution workspace
  settings) или на конкретном прогоне.
- **Проект по умолчанию**: `projectExecutionWorkspacePolicy`-подобный контейнер проекта.
- **Инстанс по умолчанию**: ключ в `instance_settings.general`, сохраняется при vendor-записях
  через `preserve…GeneralKey` (прецедент: `preserveAutonomyGeneralKey`,
  `server/src/services/instance-settings.ts:59,895`).
- **Административный cap**: верхняя граница режима для инстанса или проекта. Кап — это не
  режим, а потолок: effective = `min(выбор прогона, cap проекта, cap инстанса)` по порядку
  `supervised < auto_edits < auto < full`. Опустить режим ниже своего выбора кап не может:
  cap только срезает сверху.

Разрешение режима — по прецеденту цепочки значений tool-mapping
(`server/src/myrmidon/autonomy/tool-mapping-store.ts:75`: stored settings → env → default;
здесь: выбор задачи/прогона → дефолт проекта → дефолт инстанса, каждый уровень срезан
своим капом). **Точка: не покрыто, нужен код** (тип `PermissionMode`, резолвер, хранение).

### 3. Маппинг на существующие механизмы доски

**Матрица автономии.** Режим действует как коэффициент при вердикте, а не как замена
матрицы:

- `forbidden` → отказ во всех режимах (инвариант; `forbidden` не лифтируется никогда);
- `approval_required` → в `supervised`/`auto_edits` остаётся картой одобрения; в `auto`/`full`
  превращается в `allowed` **только** для классов действий, явно помеченных
  `modeLiftable: true` в реестре классов (`packages/shared/src/myrmidon-autonomy.ts:20` —
  потребуется флаг; **не покрыто, нужен код**). По умолчанию класс не лифтируемый:
  включение режима ничего не меняет, пока класс явно не помечен;
- `allowed` → разрешено во всех режимах.

**request_confirmation.** Контракт интеракции не меняется (схема, жизненный цикл,
supersede-правила — `server/src/services/issue-thread-interactions.ts:530,548`). Меняется
частота: в `auto`/`full` агент не создаёт `request_confirmation` для действий, разрешённых
режимом; для «всегда подтверждается» — создаёт всегда. Resolver-политика по видам
(`DEFAULT_RESOLVER_POLICY_BY_KIND`, `issue-thread-interactions.ts:385`) не меняется.

**ask_user_questions.** Не меняется ни в одном режиме (см. «не даёт»).

**Approvals / execution policy.** Стадии `review` и `approvalsNeeded` задачи
(`server/src/services/issue-execution-policy.ts:416,455`) режим не трогает: ревью идёт
всегда, `in_review`-гейт и вердикты — как сегодня.

**Consent-гейт** (`server/src/services/change-consent-gate.ts:117`): мутации чужих
инструкций/профилей/скиллов требуют принятого `request_confirmation` независимо от режима.
Это образец для enforcement списка «всегда подтверждается»: тот же приём «проверь принятую
интеракцию перед мутацией» (для режимов потребуется новая проверка; **не покрыто, нужен
код**).

**Execution-workspace policy.** Не меняется. Поле режима задачи логично живёт рядом с
`authorizationPolicy` в `IssueExecutionWorkspaceSettings` /
`ProjectExecutionWorkspacePolicy` (`packages/shared/src/types/workspace-runtime.ts:167-196`),
но это решение за ревью; поведение workspace от режима не зависит.

### 4. Точки enforcement (файл:строка на момент ADR)

| # | Точка | Статус |
|---|---|---|
| E1 | `server/src/services/tool-gateway.ts:10734-10800` — конвейер вызова инструмента: маппинг tool → класс (`:10734`), вердикт матрицы (`:10737`), 403 forbidden (`:10747`), hold `approval_required` (`:10761+`) | **покрыто, нужна правка**: здесь читать effective mode прогона и применять коэффициент из §3 |
| E2 | `server/src/myrmidon/autonomy/gate.ts:53-191` — `holdOrAssert`/`decide` для route-уровня: 403 (`:73`, `:105`), hold карта (`:112`, вставка `toolActionRequests` `:175`) | **покрыто, нужна правка**: передавать mode в решение |
| E3 | `packages/shared/src/myrmidon-autonomy.ts:20` (классы), `:242` (safe defaults), `:287` (`resolveAutonomy`) — резолвер вердикта | **покрыто, нужна правка**: флаг `modeLiftable` и параметр mode (или обёртка) |
| E4 | `server/src/myrmidon/autonomy/tool-mapping-store.ts:75` — цепочка stored → env → default | **прецедент** для резолва режима; сам не меняется |
| E5 | `server/src/services/instance-settings.ts:59,895` — `preserveAutonomyGeneralKey` | **точка для нового ключа** `myrmidonPermissionModes` (дефолт/кап инстанса); **не покрыто, нужен код** |
| E6 | `packages/shared/src/types/workspace-runtime.ts:167-196` — policy-контейнеры проекта/задачи | **кандидат** для поля режима задачи/проекта; **не покрыто, нужен код** |
| E7 | `server/src/modules/run-dispatch/adapters/postgres.ts:262` — `loadGateFacts`, гейт допуска прогона | **не покрыто, нужен код**: зафиксировать effective mode в снапшоте прогона (аудит-строка) |
| E8 | `server/src/services/change-consent-gate.ts:117` — `assertConsented` | **прецедент** enforcement «всегда подтверждается»; **не покрыто, нужен код** для остальных пунктов списка |
| E9 | `server/src/services/issue-execution-policy.ts:416,455` — стадии/approvals | **не меняется** режимами |
| E10 | `server/src/services/issue-thread-interactions.ts:385,530,548` — resolver-политика и жизненный цикл интеракций | **не меняется** режимами |
| E11 | `server/src/services/execution-workspace-policy.ts:55` — резолв стратегии workspace | **не меняется** режимами |
| E12 | `server/src/services/change-consent-gate.ts` + маршруты мутаций инструкций/скиллов | **не меняется**: consent обязателен во всех режимах |

### 5. «Всегда подтверждается» (инвариантный список, независимо от режима)

Ни один режим, включая `full`, не убирает подтверждение для:

1. **Деньги**: `spend_above_threshold` выше инстанс-лимита; любые платёжные действия
   (ADR-0014 «money only owner»).
2. **Выкат на бой** и переключение боевого конфигурационного состояния — операция ADM,
   не агента (`deploy` остаётся `approval_required` и не помечается `modeLiftable`).
3. **Слияние в `main`/`rel/*`, force-push в защищённые ссылки, правка тегов релиза.**
4. **Публикация наружу платформы**: `knowledge_external_publish` (сегодня `forbidden`,
   `AUTONOMY_SAFE_DEFAULTS`, `myrmidon-autonomy.ts:242`) и любые внешние сообщения от
   имени компании вне настроенных каналов.
5. **`rule_approve`** — сегодня `forbidden` для агентов (тест П4), остаётся человеческим.
6. **Мутации чужих инструкций/профилей/скиллов** — consent-гейт (E12).
7. **Назначение/переназначение задач на человека** и любые действия от имени владельца.
8. **Секреты**: появившийся у агента credential → `POST /api/agents/me/secret-proposals`;
   секреты никогда не пишутся в комментарии/документы/файлы.
9. **Удаление инстанс-уровня данных**: компании, агенты, доставленные knowledge-наборы.

Этот список — часть контракта ADR: реализация режимов не может его сузить; расширение
списка — новый ADR.

### 6. Что НЕ меняем (совместимость с текущими дефолтами)

- **Дефолт = `supervised`, и это сегодняшнее поведение.** Пока настройка не сохранена и
  выбор не сделан, effective mode = `supervised`, при котором все точки работают как
  сегодня: включение спеки в код ничего не меняет без явного выбора оператора (тот же
  принцип аддитивности, что у tool-mapping: «tool без класса не управляется» —
  `server/src/myrmidon/autonomy/tool-mapping.ts:21-27`).
- Матрица автономии: модель данных, вердикты, seed-дефолты, REST
  (`server/src/myrmidon/autonomy/routes.ts`) — без изменений.
- `MYRMIDON_TOOL_AUTONOMY_MAPPING_JSON` и инструментальный маппинг — без изменений.
- `ask_user_questions`, `suggest_tasks`, `connection_intent` и их resolver-политики — без
  изменений.
- Execution-workspace: режимы workspace, стратегии, egress, hygiene — без изменений.
- Execution policy: стадии, ревью, мониторы — без изменений.
- Боевой конфиг и боевой инстанс — не трогаются; это спека, кода в задаче нет.

### 7. Реализация — отдельная задача (декомпозиция на 1–2 PR)

Код режимов — отдельная задача после ревью этой спеки. Декомпозиция:

**PR 1 — контракт и резолв (малый PR):**
- `PermissionMode` + порядок резолва (задача/прогон → проект → инстанс, cap срезает
  сверху) в `packages/shared/`;
- ключ инстанса `myrmidonPermissionModes` с preserve-mount (E5) и REST read/write;
- поле режима задачи в policy-контейнере (E6) — только контракт;
- unit-тесты резолва (кап, дефолты, отсутствие настройки = supervised);
- обновление `docs/myrmidon/SETTINGS.md` и `docs/architecture/execution-workspaces.md`.

**PR 2 — enforcement (средний PR):**
- чтение effective mode в `tool-gateway.ts` (E1) и `gate.ts` (E2), коэффициент из §3 с
  `modeLiftable` (E3);
- фиксация effective mode в фактах прогона (E7) для аудита;
- enforcement инвариантного списка §5 на обезвреженных классах (E8, по образцу
  consent-гейта);
- тесты гейта по каждому режиму (mock-вердикты, без embedded Postgres — по образцу
  существующих юнит-тестов `server/src/myrmidon/autonomy/*.test.ts`);
- обновление ADR: статус `accepted`, снятие пометок «не покрыто».

Порядок: PR 1 мержится первым; PR 2 не начинает enforcement без контракта. Третий PR
(UI выбора режима в карточке задачи) — отдельно, после того как REST-контракт примут.

## Alternatives considered

- **Расширить матрицу автономии новыми вердиктами вместо словаря режимов** — отклонено:
  матрица отвечает на «роль × действие», режим отвечает на «сколько вопросов за прогон»;
  это разные оси, смешение сделает обе нечитаемыми.
- **Один булевый флаг autoApprove** — отклонено: не выражает середину (`auto_edits`) и не
  даёт капа.
- **Хранить режим в инструкциях агента** — отклонено по той же причине, по которой матрица
  не читает инструкции (`myrmidon-autonomy.ts:272-283`): режим — решение оператора, а не
  текст, который агент может «попросить» изменить.

## Consequences

- У оператора появляется один рычаг степени автономности прогона с административным
  потолком; по умолчанию поведение доски не меняется.
- Точки enforcement остаются в коде (конвейер инструментов и route-гейт), а не в промптах.
- Инвариантный список §5 фиксируется как контракт: реализации не могут его сузить без
  нового ADR.
- Спека не закрывает UI: выбор режима в карточке задачи — отдельная задача после PR 1.
