## changelog-en

### myr-handoff CLI for bot runtime (1.6.9 PF-HANDOFF-REVIEW)

- Added `myr-handoff` command to the bot-runtime image (`docker/bot-runtime/myr-ws/myr-handoff`).
- Enables one-step review handoff: pushes current branch, creates or reuses GitHub PR with issue key in title, sets issue to `in_review` with summary comment via Myrmidon API (if the issue has no review stage, pass `--reviewer <agentId>` per your instructions), and verifies work product PR binding.

## changelog-ru

### Команда myr-handoff для bot-runtime (1.6.9 PF-HANDOFF-REVIEW)

- Добавлена команда `myr-handoff` в образ bot-runtime (`docker/bot-runtime/myr-ws/myr-handoff`).
- Обеспечивает сдачу на ревью одним вызовом: выполняет `git push`, создаёт или переиспользует PR с ключом задачи в заголовке через `gh`, переводит задачу в `in_review` с комментарием через Myrmidon API (если у задачи нет стадии ревью — `--reviewer <agentId>` по правилу инструкции) и проверяет привязку PR.
