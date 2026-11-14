# OPE-13079: myr-handoff CLI for bot runtime

## English
Added `myr-handoff` command to the bot-runtime image (`docker/bot-runtime/myr-ws/myr-handoff`).
Enables one-step review handoff: pushes current branch, creates or reuses GitHub PR with issue key in title, sets issue to `in_review` with summary comment and reviewer stage via Paperclip API, and verifies work product PR binding.

## Russian
Добавлена команда `myr-handoff` в образ bot-runtime (`docker/bot-runtime/myr-ws/myr-handoff`).
Обеспечивает сдачу на ревью одним вызовом: выполняет `git push`, создаёт или переиспользует PR с ключом задачи в заголовке через `gh`, переводит задачу в `in_review` с комментарием и этапом ревьюера через Paperclip API и проверяет привязку PR.
