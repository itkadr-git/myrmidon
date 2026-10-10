## changelog-en

### 1.6.5 F-07 /agents: grouped agent list with a role, a live status and default aliases

- `/agents` in a bridged Telegram DM prints one group per direction instead
  of a flat list: the title comes from the card itself
  (`agents.metadata.telegramGroup`) or, when it is absent, from the agent-name
  prefix (`adm-*` → Infrastructure / Myrmidon, `bbq-*` → bbq, `work-*` → work,
  the rest → Other). Group titles are catalogue strings (en + ru).
- Every line names the agent, its role (`agents.title`, one line), its live
  status (`agents.status`: idle / running / paused, localised) and its aliases;
  the current addressee is marked.
- Written-off cards no longer take a slot: terminated, pending-approval and
  retired-by-name (`-retired` suffix) agents, plus service cards without a live
  board presence, are hidden. Paused cards stay out of the default list and
  come back on request (`listCompanyAddressableAgents(..., { includePaused: true })`),
  and a group holding paused cards says how many wait. The fixed
  60-agent cut-off is gone — the Telegram transport splits a long reply itself.
- Default aliases: an agent without `telegramAliases` answers to the last
  dash-separated segment of its name, lower-cased (`qa-dev-eng-15` → `15`);
  collisions get `-2`, `-3` (`work-runner-2` → `2-2` when `2` is taken). It is
  computed on read only — nothing is written to the card — and `/to`,
  `/who` and `@mention` all resolve it through the same loader.

## changelog-ru

### 1.6.5 F-07 /agents: список агентов группами, с ролью, живым статусом и дефолтными алиасами

- `/agents` в бридже Telegram DM печатает по группе на направление вместо
  плоского списка: название берётся с самой карточки
  (`agents.metadata.telegramGroup`) или, когда его нет, из префикса имени агента
  (`adm-*` → Инфраструктура/Myrmidon, `bbq-*` → bbq, `work-*` → work,
  остальные → Прочие). Названия групп — строки каталогов (en + ru).
- В каждой строке — имя агента, роль (`agents.title`, одной строкой), живой
  статус (`agents.status`: idle / running / paused, локализовано) и алиасы;
  текущий адресат помечен.
- Списанные карточки больше не занимают место: terminated, pending_approval и
  retired-по-имени (суффикс `-retired`), а также служебные без живой карточки
  скрыты. Карточки на паузе в список по умолчанию не попадают и возвращаются по
  запросу (`listCompanyAddressableAgents(..., { includePaused: true })`), а
  группа с паузой сообщает, сколько ждёт. Фиксированное обрезание на 60 агентов
  убрано — длинный ответ Telegram-транспорт делит сам.
- Дефолтные алиасы: агент без `telegramAliases` отвечает на последний
  сегмент своего имени после дефисов в нижнем регистре (`qa-dev-eng-15` → `15`);
  коллизии получают суффикс `-2`, `-3` (`work-runner-2` → `2-2`, если `2` занят).
  Вычисляется только на чтении — в карточку ничего не пишется, — и `/to`, `/who`
  и `@mention` резолвят его через общий загрузчик.