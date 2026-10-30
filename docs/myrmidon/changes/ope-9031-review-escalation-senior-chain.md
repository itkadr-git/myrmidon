## changelog-en

### Review escalation goes to a senior agent, never to a human (OPE-9031)

- When review rounds run out and the task has no `reviewEscalationPolicy`, the
  stage now passes to an agent: the current reviewer's manager (`reports_to`)
  and upward, then the project lead, then `adm`. The reviewer, the executor and
  paused or terminated agents are skipped. With nobody eligible a recovery card
  is raised instead. Tasks with a configured policy behave as before.
- One-time migration `scripts/myrmidon/escalate-human-reviews-to-agents.mjs`
  (`--dry-run` / `--apply`) moves stages already escalated to a user.

## changelog-ru

### Эскалация ревью уходит старшему агенту, а не человеку (OPE-9031)

- После исчерпания раундов ревью у задачи без `reviewEscalationPolicy` этап
  получает агент: руководитель текущего ревьюера (`reports_to`) и выше, затем
  лид проекта, затем `adm`. Ревьюер, исполнитель и агенты на паузе или
  terminated пропускаются. Если подходящих нет, создаётся recovery-карточка.
  Задачи с настроенной политикой работают как раньше.
- Разовая миграция `scripts/myrmidon/escalate-human-reviews-to-agents.mjs`
  (`--dry-run` / `--apply`) переводит уже эскалированные на пользователя этапы.
