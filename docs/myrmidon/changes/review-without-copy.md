## changelog-en

### Reviewers read the PR diff and head instead of a full task copy

A wake of a reviewer or verifier (execution stage) no longer makes the hermes
gateway adapter send the `workspace` field, so the bot gateway does not open a
full task worktree (about 0.5 GB) before the model starts. On 16.11 the
reviewers opened one roughly every 3 minutes and the bot volume lost 11 GB in
6 minutes. The review skill now tells the reviewer to read the change through
`gh pr diff`, `gh pr view` and `gh api repos/<repo>/contents/<path>?ref=<sha>`,
to open a copy only when it really needs files (`myr-ws open <KEY> <repo>
--review`, or a full copy to run a test) and to close it after the verdict
(`myr-ws close <KEY>`). Executor runs are unchanged.

## changelog-ru

### Ревьюеры читают diff и голову PR без полной копии задачи

При побудке ревьюера или верификатора (стадия исполнения) адаптер hermes больше
не передаёт поле `workspace`, и шлюз бота не открывает полную рабочую копию
задачи (около 0,5 ГБ) до старта модели. 16.11 ревьюеры открывали копию примерно
раз в 3 минуты, и том ботов за 6 минут потерял 11 ГБ. Навык ревью теперь велит
читать изменение через `gh pr diff`, `gh pr view` и
`gh api repos/<repo>/contents/<путь>?ref=<sha>`, открывать копию только при явной
нужде (`myr-ws open <KEY> <repo> --review` или полную копию ради запуска теста) и
закрывать её после вердикта (`myr-ws close <KEY>`). Прогоны исполнителей не
меняются.
