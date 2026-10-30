---
divergence-section: Трек 1 — платформа
---

## changelog-en

### A successful run without a final status no longer sends the issue to board users

- Before: when a run succeeded but left the issue without a status, and the issue had a monitor,
  execution state or execution policy (or the assignee had no manager), the issue went to
  `blocked` with no blocker and no metadata, and a "needs a disposition" card was addressed to
  board users. Agents did not pick such issues up and parent tasks stayed stuck.
- Now the escalation target is chosen by the same chain as review escalation: the assignee's
  `reports_to` upward, then the project lead, then the agent `adm`. A board user is the
  target only if the whole chain is empty.
- Issue without a workflow: handed to that agent as the `in_review` reviewer (previously only
  the direct manager).
- Issue with a monitor, execution state or policy: not taken over, the assignee and the
  workflow stay as they are. The issue becomes `blocked` with full `blockerMetadata`
  (reason, owner agent, next check) and an agent-owned `unblockDescriptor`; the owner gets one
  wake with an idempotency key tied to the source run.
- A paused assignee is handled as before. The retry wake and the direct-manager handoff are
  unchanged.
- Not included: the "open PR with CI pending -> external_service monitor" case is a separate step.
- Data fix for issues already stuck: `scripts/myrmidon/escalate-stranded-disposition.mjs`
  (dry-run by default, `--apply` to write; it does not wake owners).

## changelog-ru

### Успешный прогон без итогового статуса больше не отдаёт задачу людям на доске

- Раньше: если прогон завершился успешно, но задача осталась без статуса, а у неё был монитор,
  execution state или execution policy (или у исполнителя не было руководителя), задача уходила
  в `blocked` без блокера и метаданных, а карточка «needs a disposition» адресовалась
  пользователям доски. Агенты такие задачи не брали, родительские задачи стояли.
- Теперь адресат выбирается по той же цепочке, что и эскалация ревью: `reports_to` исполнителя
  вверх, затем лид проекта, затем агент `adm`. Пользователь доски — адресат только если вся
  цепочка пуста.
- Задача без workflow: передаётся этому агенту как рецензенту в `in_review` (раньше только
  непосредственному руководителю).
- Задача с монитором, execution state или policy: не перехватывается, исполнитель и workflow
  не меняются. Задача становится `blocked` с полным `blockerMetadata` (причина, агент-владелец,
  следующая проверка) и `unblockDescriptor` с владельцем-агентом; владелец получает одну
  побудку с ключом идемпотентности по исходному прогону.
- Исполнитель на паузе обрабатывается как раньше. Повторная побудка и передача прямому
  руководителю не менялись.
- Не вошло: случай «открытый PR, CI pending -> монитор external_service» — отдельный шаг.
- Исправление данных для уже стоящих задач: `scripts/myrmidon/escalate-stranded-disposition.mjs`
  (по умолчанию dry-run, `--apply` пишет; владельцев не будит).
