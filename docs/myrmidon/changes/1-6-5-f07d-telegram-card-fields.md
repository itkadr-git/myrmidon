---
divergence-section: Трек 4 — чаты и навыки
---

## changelog-en

### Telegram aliases and group are editable on the agent card (1.6.5 F-07 part D)

- The agent card now has a "Telegram" section: the aliases the bridge answers
  to (`agents.metadata.telegramAliases`) as an editable list of lowercase
  latin rows, and the `/agents` group title (`agents.metadata.telegramGroup`)
  as one text row with the company's existing group titles suggested through
  a `datalist`.
- With an empty alias list the section names the default alias the bridge
  computes from the agent name, so the card shows what the chat really uses
  before anyone edits it. The default rule is duplicated in the UI as a pure
  function marked `CONSOLIDATION-OPE-6318` — part A kept it server-side.
- Saving goes through the existing `PATCH /api/agents/:id { metadata }`: the
  section re-reads the agent first and merges only the two Telegram keys, so
  every other metadata key keeps its value. Invalid (not lowercase latin) and
  duplicate alias drafts are blocked before the save.
- Board UI only: no server, schema or bridge change.

## changelog-ru

### Псевдонимы и группа Telegram на карточке агента (1.6.5 F-07 часть D)

- На карточке агента появился раздел «Telegram»: псевдонимы, на которые
  отвечает мост (`agents.metadata.telegramAliases`), редактируемым списком
  строк в нижнем регистре латиницы, и название группы `/agents`
  (`agents.metadata.telegramGroup`) одной строкой с подсказками уже
  существующих групп компании через `datalist`.
- Пока список псевдонимов пуст, карточка называет псевдоним по умолчанию,
  который мост считает из имени агента, — видно то, чем чат пользуется на
  самом деле, ещё до правки. Правило умолчания продублировано в интерфейсе
  чистой функцией с меткой `CONSOLIDATION-OPE-6318`: часть A оставила его на
  сервере.
- Сохранение идёт через существующий `PATCH /api/agents/:id { metadata }`:
  раздел перечитывает агента и меняет только два ключа Telegram, прочие
  ключи метаданных сохраняются. Черновик псевдонима с недопустимыми
  символами или дубликат не проходит проверку и не сохраняется.
- Только интерфейс доски: сервер, схема и мост не тронуты.

## divergence

| ID | Что меняем | Файлы вендора | Причина | Тест-сторож | Как снимать | PR |
|---|---|---|---|---|---|---|
| TG-LOCALE-D | Раздел «Telegram» на карточке агента (часть D эпика 1.6.5 F-07, ряд TG-LOCALE): псевдонимы из `agents.metadata.telegramAliases` списком с добавлением и удалением, группа из `agents.metadata.telegramGroup` строкой с подсказками групп компании; пустой список показывает псевдоним по умолчанию из имени агента (зеркало правила моста, метка `CONSOLIDATION-OPE-6318`); сохранение — через `PATCH /api/agents/:id` с мерджем от свежего GET, прочие ключи метаданных не затираются | В вендоре помечен `myrmidon(1.6.5-TG-LOCALE-D)`: `ui/src/components/AgentConfigForm.tsx` (раздел смонтирован блоком после секции гнёзд); наши файлы: `ui/src/components/myrmidon/AgentCardTelegramFields.tsx`, `ui/src/lib/telegram-card-fields.ts`, ключ `telegramCard` в `ui/src/i18n/myrmidon-locales/{en.json,ru.json}` | Части A/B/C ряда TG-LOCALE сделали алиасы и группы работой моста, но на доске не было способа их видеть и менять — оператор правил `metadata` только руками через API | `ui/src/lib/telegram-card-fields.test.ts` (правило умолчания, валидация, мердж без потери ключей), `ui/src/components/myrmidon/AgentCardTelegramFields.myrmidon.test.tsx` (отображение, блокировка невалидного и дубликата, сохранение по dirty), `ui/src/i18n/myrmidon-i18n.test.tsx` (паритет en/ru, запрет голой латиницы в ru) | Никогда, наше поведение. Уходит вместе с рядом TG-LOCALE: при переносе вендора сверить метку `myrmidon(1.6.5-TG-LOCALE-D)` | #1143 |
