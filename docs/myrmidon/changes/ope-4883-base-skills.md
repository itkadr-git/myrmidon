## changelog-en

### Company base skills reach every agent automatically (1.6.5 BASE-SKILLS)

- The company now keeps a **base skills** list on the Skills screen: the skills
  every agent of the company is supposed to have. A base skill is given to an
  agent automatically — a new one at creation, an existing one the moment the
  skill joins the list, and again whenever the board presses "Apply to all
  agents". The fact of 06.10: `parallel-helpers` was attached to 52 of 82
  agents by hand, the other 30 silently missed it, and the SMM bot could not
  start the viewer flow it needed.
- The panel lists each base skill with the count of agents that carry it and
  names the agents that do not, so a gap is visible instead of silent. An agent
  whose adapter cannot receive skills at all is reported as such, and a base
  key that no longer exists in the skill library is flagged as "not in the
  library" — it can reach nobody.
- A base skill cannot be taken away from a single agent: the agent's own skill
  screen keeps it in the selection (it is the company list that decides).
  Removing a skill from the base list stops the automatic assignment; the
  agents that already carry it keep it.
- The registry is additive: a new `company_base_skills` table, board-only
  mutations (`GET/POST/DELETE /api/companies/{companyId}/base-skills`, plus
  `POST …/base-skills/apply`), and one activity-log entry per change
  (`company.base_skills_added` / `_removed` / `_applied`). A company without
  base skills behaves exactly as before.

## changelog-ru

### Базовые навыки компании доходят до каждого агента автоматически (1.6.5 BASE-SKILLS)

- У компании появился список **базовых навыков** на экране «Навыки» — навыки,
  которые должны быть у каждого агента. Базовый навык выдаётся автоматически:
  новому агенту при создании, существующему — в момент добавления навыка в
  список, и повторно по кнопке «Выдать всем агентам». Факт 06.10:
  `parallel-helpers` был выдан вручную 52 из 82 агентов, остальные 30 молча
  остались без него, и SMM не смог запустить нужный поток «зрителя».
- Панель показывает по каждому базовому навыку число агентов, у которых он
  есть, и имена тех, у кого его нет — пропуск видно, а не молчание. Агент,
  адаптер которого вообще не принимает навыки, показан отдельной причиной, а
  базовый ключ, которого больше нет в библиотеке навыков, помечен «нет в
  библиотеке»: доставить его некому.
- Отобрать базовый навык у отдельного агента нельзя: экран навыков агента
  сохраняет его в наборе (решает список компании). Удаление из списка базовых
  прекращает автоматическую выдачу; у агентов, у которых навык уже есть, он
  остаётся.
- Реестр аддитивный: новая таблица `company_base_skills`, мутации только для
  доски (`GET/POST/DELETE /api/companies/{companyId}/base-skills` и
  `POST …/base-skills/apply`), по одной записи журнала на изменение
  (`company.base_skills_added` / `_removed` / `_applied`). Компания без базовых
  навыков ведёт себя ровно как раньше.

## divergence-new

<!-- after: 1.6 — сбор знаний из источников (FORAGING) -->

### 1.6.5 — BASE-SKILLS: базовые навыки компании выдаются всем агентам

Реестр базовых навыков компании: список навыков, которые есть у каждого агента.
Выдача автоматическая — новому агенту в `agentService.create` (любой путь
создания: маршрут найма, шаблон, встроенный агент, одобренная заявка),
существующим агентам в момент добавления навыка в список и повторно по
`POST …/base-skills/apply`. Набор пишется в собственный `paperclipSkillSync`
агента, поэтому доставка, счётчики библиотеки и экран агента продолжают читать
один набор. Сторож панели показывает, у кого какого базового навыка нет, и
почему: причина `not_assigned` (исправимо кнопкой) или `adapter_unsupported`
(адаптер не принимает навыки). Навык, удалённый из списка базовых, перестаёт
выдаваться, но у агентов остаётся; отобрать базовый навык у одного агента
нельзя — правка навыков агента его сохраняет.

| ID | Что меняем | Файлы вендора | Причина | Тест-сторож | Как снимать | PR |
|---|---|---|---|---|---|---|
| 1.6.5-BASE-SKILLS | Компания ведёт список базовых навыков (аддитивная таблица `company_base_skills`: companyId, FK на навык библиотеки с каскадом, ключ, кто и когда добавил; уникальность по компании и ключу/навыку). Базовый навык доходит до каждого агента сам: при создании агента набор компании вливается в его `paperclipSkillSync.desiredSkills` в `agentService.create`; при добавлении навыка в список сервис применяет список ко всем агентам компании сразу (терминальные и ожидающие одобрения агенты не трогаются, их конфиг закрыт), повторное применение идемпотентно и не пишет ревизию конфига. Правка навыков одного агента не может убрать базовый навык (набор объединяется после применения режима `add`/`remove`/`replace`) — решает список компании. Экран «Навыки» получает панель «Базовые навыки»: список с числом агентов, имена агентов-пропусков, добавление через диалог по библиотеке, кнопки «Выдать всем агентам» и удаление из списка. Маршруты `GET/POST/DELETE /api/companies/{companyId}/base-skills` и `POST …/base-skills/apply` (чтение — доступ к компании, мутации — только доска), тело `{ keys }`, ответ — список с пропусками и результат применения; журнал `company.base_skills_added` / `_removed` / `_applied`, ревизии конфига с источником `base-skills` | `server/src/services/agents.ts` (вливание базовых навыков при создании, метка `myrmidon(1.6.5 BASE-SKILLS)`), `server/src/routes/agents.ts` (объединение набора при правке навыков агента и импорт хелперов, та же метка), `server/src/app.ts` (импорт и `api.use`), `server/src/services/index.ts` (экспорт сервиса), `server/src/routes/openapi.ts` (описание четырёх маршрутов), `server/src/__tests__/openapi-routes.test.ts` (файл маршрутов в карте префиксов), `ui/src/pages/CompanySkills.tsx` (панель на экране навыков), `ui/src/lib/queryKeys.ts` (ключ запроса), `packages/db/src/schema/index.ts` и `packages/shared/src/index.ts` (экспорт таблицы и контракта). Наши файлы: `packages/db/src/schema/company_base_skills.ts`, миграция `0301_base_skills.sql` (+ meta journal/snapshot, drizzle-kit), `packages/shared/src/myrmidon-base-skills.ts`, `server/src/services/company-base-skill-keys.ts` (чистые хелперы чтения и объединения, без импортов сервисов — вызываются из `create`), `server/src/services/company-base-skills.ts` (сервис реестра), `server/src/routes/company-base-skills.ts`, `ui/src/api/baseSkills.ts`, `ui/src/components/skill-studio/CompanyBaseSkillsPanel.tsx` | Факт 06.10: навык `parallel-helpers` был выдан только 52 из 82 агентов — вручную, по направлениям adm и work; боты bbq, dispatch, life, qa17 и Wiki Maintainer остались без него, и SMM не смог запустить поток «зрителя» для приёмки ролика. Пер-агентная выдача протекает молча: новый агент не получает ничего, если про него забыли, а увидеть пропуск было негде. Вендорского понятия «навык обязателен для всех агентов компании» нет — есть только персональные наборы | `server/src/myrmidon/base-skills/base-skills.myrmidon.test.ts` (новый агент получает базовые навыки при создании и сохраняет свои; компания без базовых навыков не меняет конфиг; объявление базового навыка выдаёт его существующим агентам и не трогает терминальных и ожидающих одобрения; повторное применение не пишет ревизию; правка навыков агента не отбирает базовый навык; пропуски с причинами `not_assigned`/`adapter_unsupported`; вторая компания не затронута; неизвестный ключ отвергается; удаление из списка перестаёт выдавать, но не отбирает навык; HTTP-маршруты: 403 агенту, 201/200/404, применение и удаление) | Никогда, наше поведение (новый реестр, вендорский путь персональных наборов не изменён). Снять: удалить сервис и маршруты, панель, контракт и таблицу; вендорские строки находятся по метке `myrmidon(1.6.5 BASE-SKILLS)`. Миграция не снимается — таблица остаётся | (этот PR) |