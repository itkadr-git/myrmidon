## changelog-en

### Plan gate for large engineering tasks (1.6.9 PF-PLAN-GATE, OPE-13081)

- Engineering issues labeled `size:M` / `size:L` without a `plan` document now start in planning mode and require approval bound to the plan revision before implementation.
- An update moves an issue to planning only while it is in `backlog` or `todo` and its labels or assignee actually changed; started work (`in_progress`, `in_review`) is never returned to planning. An explicit `workMode` on create is kept.
- The approver is the first invokable `lead` / `architect` agent in the executor's manager chain, then any such agent of the company, then the agent `adm`. The board always sets the approver and rejects a plan request that would be approved by its author.
- While plan approval is pending, no run of the assignee starts for any wake type (comment, interaction or automatic continuation); only the plan approval card's own resolution (accepted or rejected) passes the gate.

## changelog-ru

### Утверждение плана для крупных инженерных задач (1.6.9 PF-PLAN-GATE, OPE-13081)

- Инженерные задачи с меткой `size:M` / `size:L` без документа `plan` теперь начинают работу в режиме планирования и требуют подтверждения ревизии плана до реализации.
- Обновление переводит задачу в planning только в статусах `backlog` / `todo` и только если метки или исполнитель реально изменились; начатая работа (`in_progress`, `in_review`) в planning не возвращается. Явно переданный при создании `workMode` сохраняется.
- Утверждает первый доступный агент с ролью `lead` / `architect` в цепочке руководителей исполнителя, затем любой такой агент компании, затем агент `adm`. Адресата всегда назначает доска; запрос плана, который утвердил бы сам автор, отклоняется.
- Пока план не утверждён, ни один прогон исполнителя не стартует при любом типе побудки (комментарий, interaction, автопродолжение); гейт проходит только само решение по карточке плана (принято или отклонено).
