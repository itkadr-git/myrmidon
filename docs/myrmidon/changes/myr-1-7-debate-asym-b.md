---
divergence-section: Трек 5 — эксплуатация
settings-section: Track 5 — operations
---

## changelog-en

### Debates per caste and the «Discuss» button on a caste's task (DEBATE-ASYM B)

- Every caste now has its own debate configuration, on top of the instance
  level part A introduced: whether debates run for the caste at all, the model
  of each role, extra guidance per role, the rounds (at most three) and the
  token ceiling. The entry is stored inside the same
  `instance_settings.general.debate` value, under `castes.<key>`, pinned to its
  company — so there is no migration, no restart (it is read at run time), and
  an entry written for another company is inert instead of silently driving a
  same-named caste elsewhere. A caste with no entry of its own inherits the
  instance configuration and is **on**; the switch exists to take a caste out
  of the spend.
- The screen is Instance → General → Asymmetric debates → **Debates per caste**
  (the instance roles stay above it); the API is
  `GET`/`PATCH /api/myrmidon/companies/:companyId/debates/castes/:casteKey/settings`
  (board reads, instance admin writes, every save audited as
  `debate.caste_settings.saved`). Both the switch and the configuration show
  where their value comes from (*set for this caste* / *inherited from the
  instance level*), and a save applies to the next debate with no restart.
- The cross-family rule is re-checked on the **merged** configuration: a caste
  that overrides only the critic cannot slip a same-family judge past it, and
  nothing is stored when the result cannot run. A caste's guidance per role is
  appended to the built-in pole prompt — the critic keeps its adversarial pole
  and its missed-error penalty; a caste narrows where a role looks, it does not
  change the nature of the dispute.
- A debate can be started **from the task of a caste**: every row of a role
  queue on the swarm supervisor page (`/swarm-claim`) carries a **Discuss**
  button, which runs one debate for that task with the row's caste
  (`POST …/debates/issues/:issueId/run` with `{ casteKey }`) and shows the
  judge's verdict, how the debate stopped, the rounds, tokens and cost, the
  caste and which roles used custom guidance, and the name of the result
  document. The transcript, the roles and the cost still land on the task as
  the `debate-result` document and as task-level cost events, so BUDGET-CONFIG
  counts a debate like any other work. A switched-off caste refuses the run with
  `422 debate_caste_disabled` and the screen says where the switch lives; a task
  that is not routed to a caste keeps part A's instance-level behaviour.
- Pilot: the marketing caste. Check the engine is configured (three families),
  pick *marketing* in *Debates per caste*, set its models/rounds/ceiling and —
  if the caste needs it — its own guidance per role, then press **Discuss** on a
  marketing task in the role queue. Guide:
  `docs/myrmidon/guides/debate-asym-castes.md` (RU:
  `debate-asym-castes.ru.md`).

## changelog-ru

### Дебаты на касту и кнопка «Обсудить» на задаче касты (DEBATE-ASYM B)

- У каждой касты теперь своя конфигурация дебатов поверх уровня инстанса из
  части A: идут ли для касты дебаты вообще, модель каждой роли, своя инструкция
  на роль, число кругов (не больше трёх) и потолок токенов. Запись хранится
  внутри того же значения `instance_settings.general.debate`, в карте
  `castes.<key>`, и привязана к компании — поэтому нет миграции и нет
  перезапуска (значение читается на каждом запуске), а запись, сделанная для
  другой компании, инертна и не управляет молча одноимённой кастой в другом
  месте. Каста без своей записи наследует конфигурацию инстанса и **включена**;
  выключатель нужен, чтобы убрать касту из расхода.
- Экран — Инстанс → Общие → Асимметричные дебаты → **Дебаты по кастам** (роли
  уровня инстанса остаются выше); API —
  `GET`/`PATCH /api/myrmidon/companies/:companyId/debates/castes/:casteKey/settings`
  (чтение — board, запись — админ инстанса, каждое сохранение в журнале
  активности как `debate.caste_settings.saved`). И у выключателя, и у
  конфигурации показан источник значения (*задано для этой касты* /
  *унаследовано с уровня инстанса*), сохранение действует на следующем дебате
  без перезапуска.
- Правило разных семейств перепроверяется на **итоговой** конфигурации: каста,
  переопределившая только критика, не протащит судью того же семейства, и
  ничего не сохраняется, если результат не может работать. Инструкция касты на
  роль **дописывается** к встроенному промпту полярности — у критика остаются
  адверсариальная полярность и штраф за пропущенную ошибку; каста сужает, куда
  смотреть роли, но не меняет природу спора.
- Дебаты можно запустить **из задачи касты**: в каждой строке очереди роли на
  «Надзоре за роем» (`/swarm-claim`) есть кнопка **«Обсудить»** — она проводит
  один дебат по этой задаче с кастой строки
  (`POST …/debates/issues/:issueId/run` с `{ casteKey }`) и показывает вердикт
  судьи, причину остановки, круги, токены и стоимость, касту и роли со своей
  инструкцией, а также имя документа результата. Транскрипт, роли и стоимость
  по-прежнему ложатся на задачу документом `debate-result` и cost-событиями
  уровня задачи, так что BUDGET-CONFIG считает дебат как любую другую работу.
  Выключенная каста отклоняет запуск кодом `422 debate_caste_disabled`, и экран
  подсказывает, где выключатель; задача, не привязанная к касте, сохраняет
  поведение части A.
- Пилот — каста маркетинга. Проверить, что движок настроен (три семейства),
  выбрать *marketing* в «Дебаты по кастам», задать модели/круги/потолок и — если
  касте нужно — свою инструкцию на роль, затем нажать **«Обсудить»** у задачи
  маркетинга в очереди роли. Гайд:
  `docs/myrmidon/guides/debate-asym-castes.md` (RU:
  `debate-asym-castes.ru.md`).

## divergence

| 1.7-DEBATE-ASYM-B | Настройки дебатов на касту (вкл, модели ролей, инструкция на роль, круги, потолок токенов) и кнопка «Обсудить» на задаче касты. Карта `castes.<key>` живёт внутри того же значения `instance_settings.general.debate`, что и конфигурация инстанса части A (миграции нет намеренно: значение уже владеет конфигурацией движка и ключом сохранения; колонка на `agent_castes` потребовала бы сгенерированной drizzle-миграции), запись привязана к компании, читается на каждом запуске/записи — смена без перезапуска, источник значения показан. Маршруты `GET`/`PATCH /api/myrmidon/companies/:companyId/debates/castes/:casteKey/settings` (чтение — board, запись — админ инстанса, аудит `debate.caste_settings.saved`), запуск `POST …/debates/issues/:issueId/run` с `{ casteKey }` (выключенная каста — `422 debate_caste_disabled`, неизвестная — `404 debate_caste_not_found`, задача без касты — путь части A). Кнопка «Обсудить» — в строке очереди роли на «Надзоре за роем», результат (вердикт, остановка, круги/токены, стоимость, документ `debate-result`) показывается под кнопкой; тексты — ключи форк-каталога `swarm.discuss*` | `packages/shared/src/index.ts` — одна строка экспорта контракта с маркером `myrmidon(1.7-DEBATE-ASYM-B)`. Остальное наше: `packages/shared/src/myrmidon-debate-castes{,.test}.ts`, `server/src/myrmidon/debates/{castes,routes,service}.ts` (+`debates-castes.myrmidon.test.ts`), `ui/src/components/myrmidon/{CasteDebateSettingsPanel,DebateTaskButton}.tsx` (+`{CasteDebateSettingsPanel,DebateTaskButton}.myrmidon.test.tsx`), `ui/src/components/myrmidon/debateApi.ts`, `ui/src/pages/SwarmSupervisor{,.production}.tsx` (наши файлы 1.6-SWARM-CLAIM-B), `ui/src/i18n/myrmidon-locales/{en,ru}.json` (форк-каталог), `docs/myrmidon/guides/debate-asym-castes{,.ru}.md` | OPE-4170 (1.7 DEBATE-ASYM B): дебаты включаются и настраиваются для касты в интерфейсе, пилот — каста маркетинга; настройка поведения — в интерфейсе без перезапуска, с показом источника значения. У вендора дебатов нет | `packages/shared/src/myrmidon-debate-castes.test.ts` (разбор записи и ключа, чужая компания, прецедентность, отказ на коллизии семейств, гейт запуска, дописывание инструкции к полярности, документ с кастой), `server/src/myrmidon/debates/debates-castes.myrmidon.test.ts` (хранилище: сохранение конфигурации инстанса и других каст, инертность чужой записи, отказ перезаписи не-объекта; сервис: чтение/запись/сброс/аудит и отказы; запуск: конфигурация и инструкции касты, выключатель, каста из задачи, путь части A), `ui/src/components/myrmidon/{CasteDebateSettingsPanel,DebateTaskButton}.myrmidon.test.tsx` (поля и источники, dirty-гейт, сброс; показ результата, отказ выключенной касты) | Никогда, наше поведение. Снять: удалить модуль `myrmidon-debate-castes.ts`, каст-маршруты и хранилище, панель «Дебаты по кастам» и кнопку, ключи `swarm.discuss*` и строку маркера в `packages/shared/src/index.ts`; удаление ключа `debate` из `instance_settings.general` снимает и уровень инстанса (часть A), и карту каст | (этот PR) |

## settings-en

| `MYRMIDON_DEBATE_CONFIG` | 1.7-DEBATE-ASYM A/B | unset (built-in default) | Forced JSON override of the **instance-level** debate role configuration (`{generator,critic,judge}` model ids, optional `rounds` 1..3 and `tokenCeiling`) while nothing is stored in `instance_settings.general.debate`; part B's per-caste map (`castes.<key>`: `enabled`, role models, `prompts`, `rounds`, `tokenCeiling`) lives inside the same stored value. Both levels are read at run/PATCH time — no restart — and the screen shows the source of every value (caste entry / stored row / env / built-in default) | Unset or empty — the next level applies. The caste level has **no environment variable**: it is only what an operator saves on Instance → General → Asymmetric debates → Debates per caste (`GET`/`PATCH /api/myrmidon/companies/:companyId/debates/castes/:casteKey/settings`, PATCH is instance-admin, `settings: null` clears the entry back to inheriting). Malformed JSON, a malformed caste entry or a symmetric configuration (one family for generator and critic, or the judge sharing a debater's family — re-checked on the merged configuration) is reported as the reason and refused at every level, never silently replaced. Full guides: [guides/debate-asym.md](guides/debate-asym.md), [guides/debate-asym-castes.md](guides/debate-asym-castes.md) |

## settings-ru

| `MYRMIDON_DEBATE_CONFIG` | 1.7-DEBATE-ASYM A/B | не задана (встроенное умолчание) | Принудительное JSON-переопределение конфигурации дебатов **уровня инстанса** (`{generator,critic,judge}` — идентификаторы моделей, необязательные `rounds` 1..3 и `tokenCeiling`), пока в `instance_settings.general.debate` ничего не сохранено; карта каст части B (`castes.<key>`: `enabled`, модели ролей, `prompts`, `rounds`, `tokenCeiling`) лежит внутри того же значения. Оба уровня читаются на каждом запуске/записи — без перезапуска — и экран показывает источник каждого значения (запись касты / сохранённая строка / env / встроенное умолчание) | Не задана или пустая — применяется следующий уровень. Уровня каст **нет переменной окружения**: это только то, что оператор сохранил на «Инстанс → Общие → Асимметричные дебаты → Дебаты по кастам» (`GET`/`PATCH /api/myrmidon/companies/:companyId/debates/castes/:casteKey/settings`, PATCH — администратор инстанса, `settings: null` снимает запись и возвращает наследование). Кривой JSON, кривая запись касты или симметричная конфигурация (одно семейство у генератора и критика, либо судья из семейства спорщика — перепроверяется на итоговой конфигурации) сообщаются как причина и отклоняются на каждом уровне, а не подменяются молча. Гайды: [guides/debate-asym.md](guides/debate-asym.md), [guides/debate-asym-castes.md](guides/debate-asym-castes.md) |