---
divergence-section: 1.6.5 — BOT-DISK-H3b: правила удаления botd
---

## changelog-en

### botd deletion rules as a pure function (1.6.5 BOT-DISK-H, part H3b)

- New `docker/bot-runtime/botd/lib/rules.js`: `decide(inventory, desired, now,
  settings)` returns the list of actions (`remove`, `archive-remove`, `prune`,
  `delete-base`, `delete-archive`) for the table of the bot-disk design, section
  2.3. It only returns data; nothing is executed and nothing is read from disk.
- A closing copy goes after the grace period (30 minutes by default): clean and
  pushed, or its PR is merged (squash-merge) — removed; anything else —
  archived first. A copy missing from the board's list is treated as closing with
  a 24-hour grace. A copy of an active task is never removed; a vanished
  directory is only pruned.
- Pressure from the board (`soft`) drops the grace to zero, the scratch TTL to
  one hour and archive age to seven days; `hard` does the same and `plan()`
  also returns `blockOpen: true`. A base repository with no worktree for 30 days
  is deleted, over eight bases the oldest idle one goes, archives expire after
  30 days or past the 2 GiB cap (oldest first).
- No desired state from the board (error, 401/403/503) deletes nothing.

## changelog-ru

### Правила удаления botd — чистая функция (1.6.5 BOT-DISK-H, часть H3b)

- Новый `docker/bot-runtime/botd/lib/rules.js`: `decide(inventory, desired, now,
  settings)` возвращает список действий (`remove`, `archive-remove`, `prune`,
  `delete-base`, `delete-archive`) по таблице п. 2.3 проекта диска ботов. Только
  данные: ничего не выполняется и с диска не читается.
- Копия `closing` уходит после grace (по умолчанию 30 минут): чистая и запушенная
  или с PR `merged` (squash-merge) — удаляется, иначе сначала архив. Копия, которой
  нет в списке доски, — как `closing` с grace 24 часа. Копию активной задачи не
  удаляет никогда; пропавший каталог только `prune`.
- Давление `soft` с доски обнуляет grace, ставит TTL scratch 1 час и возраст
  архивов 7 суток; `hard` — то же, и `plan()` возвращает `blockOpen: true`. База без
  worktree 30 суток удаляется, сверх восьми баз уходит старейшая без worktree,
  архивы — через 30 суток или сверх 2 ГиБ (старые первыми).
- Нет желаемого состояния от доски (ошибка, 401/403/503) — ничего не удаляется.

## divergence

| 1.6.5-BOT-DISK-H3b | Решающая функция правил удаления botd (`decide`/`plan`), без выполнения действий | Наш файл: `docker/bot-runtime/botd/lib/rules.js`. Маркеров вендора нет | Требование OPE-5355 (часть H3 проекта диска ботов) | `scripts/myrmidon/bot-runtime/botd-rules.test.mjs` | Никогда, наше поведение. Снятие: удалить файл и тест | (этот PR) |
