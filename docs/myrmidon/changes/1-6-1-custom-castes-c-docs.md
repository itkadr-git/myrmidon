---
divergence-section: 1.6.1 — CUSTOM-CASTES, часть B: потребители справочника каст
---

## changelog-en

### Custom castes in the interface (CUSTOM-CASTES C)

- The company caste directory now has a screen: **Company Settings → Agent
  castes** (`/company/settings/caste-directory`). The first visit seeds the
  twelve built-in castes; the owner adds their own, edits names (EN/RU),
  description, color (token palette), icon, default model, swarm
  participation (`swarmEligible`) and a per-caste active-task limit (empty =
  the global swarm limit). Create/edit/delete go through part A's API
  (`POST`/`PATCH`/`DELETE` `/api/myrmidon/companies/:id/castes[/:key]`); the
  caste key and the built-in flag never change after creation. A caste with
  live agents on it cannot be deleted outright: the screen asks for a
  reassignment target and the delete runs only with `reassignTo` — the agents
  (and their queued tasks, which follow `agents.role`) move to the target
  caste in one transaction. The same directory drives every role picker: the
  role select on the agent card, the role rows of the autonomy matrix and
  the onboarding select all list the company's castes, falling back to the
  built-in twelve while the directory is unavailable. A custom role that has
  no directory entry displays its key instead of breaking the label.

## changelog-ru

### Свои касты в интерфейсе (CUSTOM-CASTES C)

- Справочник каст компании получил экран: **Настройки компании → Касты
  агентов** (`/company/settings/caste-directory`). При первом открытии
  засеиваются двенадцать встроенных каст; владелец добавляет свои, правит
  названия (EN/RU), описание, цвет (палитра токен-слоя), иконку, модель по
  умолчанию, участие в рое (`swarmEligible`) и лимит активных задач касты
  (пусто = глобальный лимит роя). Создание, правка и удаление идут через API
  части A (`POST`/`PATCH`/`DELETE`
  `/api/myrmidon/companies/:id/castes[/:key]`); ключ касты и флаг встроенной
  после создания не меняются. Касту, на которой стоят живые агенты, просто
  так не удалить: экран просит выбрать, куда их переназначить, и удаление
  проходит только с `reassignTo` — агенты (и их задачи в очереди, которая
  строится по `agents.role`) переходят на целевую касту одной транзакцией.
  Тот же справочник питает все выборы роли: селект роли в карточке агента,
  строки ролей в матрице автономии и селект онбординга показывают касты
  компании, а при недоступном справочнике откатываются на двенадцать
  встроенных. Роль без записи в справочнике показывает свой ключ вместо
  метки и не ломает интерфейс.

## settings-en-append

<!-- section: 1.6.1 — CUSTOM-CASTES B: caste-directory consumers (role validator, swarm gate) -->

### The "Agent castes" screen (CUSTOM-CASTES C)

The directory of part A is managed in the interface: **Company Settings →
Agent castes** (`/company/settings/caste-directory`). The screen has no
tunables of its own — it is the UI over the part A API (`POST`/`PATCH`/`DELETE
/api/myrmidon/companies/:id/castes[/:key]`, mutations board-only):

- Add caste: `key` (latin letters, digits, hyphens, 1–60 — it becomes the
  agent role string and is locked after creation), EN/RU names, description,
  color from the token palette, icon, default model, `swarmEligible` and a
  per-caste `maxActiveTasks` (empty = the global swarm limit).
- Edit: everything except `key` and the built-in flag.
- Delete: a caste with live agents on it is refused with a 409 until a
  reassignment target is chosen; with `reassignTo` the delete moves the
  agents to the target caste in one transaction (their queued tasks follow,
  because the swarm queue is built from `agents.role`).

The directory also feeds every role picker — the agent card role select, the
autonomy matrix role rows and the onboarding select — and each picker falls
back to the built-in twelve castes while the directory is unavailable, so the
UI never loses its role list.

## settings-ru-append

<!-- section: 1.6.1 — CUSTOM-CASTES B: потребители справочника каст (валидатор роли, гейт роя) -->

### Экран «Касты агентов» (CUSTOM-CASTES C)

Справочник части A управляется из интерфейса: **Настройки компании → Касты
агентов** (`/company/settings/caste-directory`). Своих регуляторов у экрана
нет — это UI над API части A (`POST`/`PATCH`/`DELETE
/api/myrmidon/companies/:id/castes[/:key]`, мутации только для владельца):

- Добавление касты: `key` (латиница, цифры, дефисы, 1–60 — становится строкой
  роли агента и после создания не меняется), названия EN/RU, описание, цвет
  из палитры токен-слоя, иконка, модель по умолчанию, `swarmEligible` и лимит
  `maxActiveTasks` касты (пусто = глобальный лимит роя).
- Правка: всё, кроме `key` и флага встроенной касты.
- Удаление: касту, на которой стоят живые агенты, сервер отклоняет с 409,
  пока не выбрана цель переназначения; с `reassignTo` удаление переводит
  агентов на целевую касту одной транзакцией (их задачи в очереди следуют за
  ними, потому что очередь роя строится по `agents.role`).

Справочник также питает все выборы роли — селект роли в карточке агента,
строки ролей матрицы автономии и селект онбординга — и каждый из них при
недоступном справочнике откатывается на двенадцать встроенных каст, поэтому
список ролей в интерфейсе не пропадает никогда.

## divergence

| 1.6.1-CUSTOM-CASTES-C | UI справочника каст компании. Экран «Касты агентов» (`/company/settings/caste-directory`, пункт `caste-directory` в CompanySettingsNav после Castes & models): форма добавления (key — латиница/цифры/дефис, 1–60, фиксируется при создании; имена EN/RU, описание, цвет из палитры токен-слоя `CASTE_COLOR_VARS`, иконка из курируемого набора, defaultModel, swarmEligible, maxActiveTasks), таблица каст со строковой правкой (всё, кроме key/builtIn) и удалением с подтверждением; 409 «касту держат агенты» превращается в требование выбрать цель `reassignTo`, повторный DELETE с ним переводит агентов и удаляет касту транзакционно (фикс #438 — удаление строки касты внутри той же транзакции). Общий читатель `useCasteOptions` питает селект роли карточки агента (`AgentConfigForm`), строки ролей матрицы автономии (`AutonomyMatrixScreen`, `autonomyRoleOptions`) и селект онбординга: записи справочника побеждают (метка RU → EN → key), недостающие встроенные дописываются, недоступный/пустой справочник — полный фолбэк на `AGENT_ROLES`/`AGENT_ROLE_LABELS`; роль без записи показывает ключ. Неймспейс `castes` во всех 42 локалях (EN в en, RU в ru, английский текст в остальных — паритет ключей держит вендорский валидатор) | Наши файлы: `ui/src/components/myrmidon/castes/{CastesScreen,CastesContainer,castesApi,useCasteOptions}.tsx/ts` + четыре теста рядом; в вендоре помечены `myrmidon(1.6.1 CUSTOM-CASTES C)`: `ui/src/App.tsx` (импорт + маршрут), `ui/src/components/access/CompanySettingsNav.tsx` (пункт, активная секция до префиксной проверки /castes), `ui/src/components/AgentConfigForm.tsx` (селект роли из справочника), `ui/src/components/OnboardingWizard.tsx`, `ui/src/lib/onboarding-agent-role.ts` (labels-фолбэк), `ui/src/components/myrmidon/autonomy/AutonomyMatrixScreen.tsx`, `ui/src/i18n/locales/*.json` (неймспейс `castes`) | Пункт релиза 1.6.1 CUSTOM-CASTES: владелец заводит и правит касты из интерфейса, а не через API; удаление касты не сиротит агентов; все выборы роли показывают живой справочник | `CastesScreen.myrmidon.test.tsx` (форма, таблица, правка, удаление с 409 → reassignTo), `CastesContainer.myrmidon.test.tsx` (wire-ярус: запросы по компании, мутации, инвалидация), `useCasteOptions.myrmidon.test.tsx` (справочник побеждает, фолбэки, метка роли), `AutonomyMatrixScreen.myrmidon.test.tsx` (строки ролей из справочника), `AgentConfigForm.render.test.tsx` (селект роли из справочника), `onboarding-agent-role.test.ts` (имя по метке справочника с фолбэком) | Никогда, наше поведение. Уходит вместе с эпиком: удалить каталог `ui/src/components/myrmidon/castes/`, пункт навигации, маршрут, неймспейс локалей и снять маркеры `myrmidon(1.6.1 CUSTOM-CASTES C)` | [#433](https://github.com/itkadr-git/myrmidon/pull/433) |
