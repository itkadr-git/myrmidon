## changelog-ru

### 1.6.5 SWARM-SETTINGS: рой включается одним переключателем, пилота нет

- Instance → General → **«Self-organisation (swarm)»**: один переключатель `Swarm enabled`
  (по умолчанию выключен; на бою включается переменной `MYRMIDON_SWARM_CLAIM_ENABLED=1` или
  здесь). Какие агенты участвуют в рое, решает справочник каст (флаг `swarmEligible` у касты)
  и переключатель в карточке агента (`swarmQueueEligible`), больше ничего.
- Удалено: поля «Roles in scope» и «Companies in scope», поле «Idle wake batch»,
  переменные `MYRMIDON_SWARM_CLAIM_ENABLED_ROLES`, `MYRMIDON_SWARM_CLAIM_ENABLED_COMPANY_IDS`,
  `MYRMIDON_SWARM_IDLE_WAKE_BATCH`, функция `orderIdleWakeAgents`, зашитое правило «у кого есть подчинённые — тот не берёт задачи»
  (`hasDirectReports`). Руководитель получает задачи, если его каста `swarmEligible`; не
  хотите — заведите ему касту с выключенным флагом или выключите переключатель в его карточке.
- Настройки роя по-прежнему лежат под ключом `general.swarmClaim` (`general.swarm` — блок
  стража побудок F-26: шлагбаум «прогон только с задачей» и окно остывания). Значение,
  сохранённое прежней сборкой с пилотными полями, читается как есть: лишние поля
  отбрасываются, переключатель не теряется.
- Причина освобождения аренд при выключении роя теперь `swarm_disabled` (было
  `pilot_disabled`); старые записи журнала остаются как были.
- Как проверить: включить переключатель, под ним смотреть строку состояния —
  «захвачено за час» растёт, «отменено за час» нет. Подробно — в руководстве
  [guides/swarm-claim-settings.ru.md](../guides/swarm-claim-settings.ru.md).

## changelog-en

### 1.6.5 SWARM-SETTINGS: the swarm has one switch, there is no pilot

- Instance → General → **"Self-organisation (swarm)"**: one `Swarm enabled` switch (off by
  default; in production it is turned on by `MYRMIDON_SWARM_CLAIM_ENABLED=1` or here). Which
  agents take part is decided by the caste directory (the caste's `swarmEligible` flag) and the
  switch in the agent's card (`swarmQueueEligible`), nothing else.
- Removed: the "Roles in scope" and "Companies in scope" fields, the "Idle wake batch" field,
  the variables `MYRMIDON_SWARM_CLAIM_ENABLED_ROLES`, `MYRMIDON_SWARM_CLAIM_ENABLED_COMPANY_IDS`,
  `MYRMIDON_SWARM_IDLE_WAKE_BATCH`, the function `orderIdleWakeAgents`, and the hardcoded rule "an agent others report to takes no tasks"
  (`hasDirectReports`). A lead gets tasks when its caste is `swarmEligible`; to keep it out,
  give it a caste with the flag off or turn the switch off in its card.
- The swarm settings stay under `general.swarmClaim` (`general.swarm` is the F-26 wake-guard
  block: the run-only-with-a-task gate and the cooling window). A value saved by an earlier
  build with the pilot fields is read as is: the extra fields are dropped and the switch is not
  lost.
- The release reason for leases freed when the swarm is switched off is now `swarm_disabled`
  (was `pilot_disabled`); old activity rows stay as they were.
- How to check: turn the switch on and watch the status line under it —
  "claimed in the last hour" grows, "cancelled in the last hour" does not. Details in
  [guides/swarm-claim-settings.md](../guides/swarm-claim-settings.md).

## settings-en-append

<!-- section: 1.6.1 — SWARM-SETTINGS-UI: queues of roles as instance settings -->
Since 1.6.5 the panel is called "Self-organisation (swarm)"; the settings stay under
`general.swarmClaim`.
The pilot is gone: there are no role or company lists and no idle-wake batch — the variables
`MYRMIDON_SWARM_CLAIM_ENABLED_ROLES`, `MYRMIDON_SWARM_CLAIM_ENABLED_COMPANY_IDS` and
`MYRMIDON_SWARM_IDLE_WAKE_BATCH` are removed, and a stored value that still carries those
fields is read with them dropped. Who takes part in the swarm is decided by the caste directory
(`swarmEligible`) and the agent's own switch.

## settings-ru-append

<!-- section: 1.6.1 — SWARM-SETTINGS-UI: очереди ролей как настройки инстанса -->
С 1.6.5 панель называется «Self-organisation (swarm)»; настройки по-прежнему
хранятся под ключом `general.swarmClaim`.
Пилота нет: нет списков ролей и компаний и пачки idle-побудок — переменные
`MYRMIDON_SWARM_CLAIM_ENABLED_ROLES`, `MYRMIDON_SWARM_CLAIM_ENABLED_COMPANY_IDS` и
`MYRMIDON_SWARM_IDLE_WAKE_BATCH` удалены, а сохранённое значение с этими полями читается с
их отбрасыванием. Кто участвует в рое, решает справочник каст (`swarmEligible`) и
переключатель в карточке агента.
