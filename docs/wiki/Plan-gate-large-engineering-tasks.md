# Plan gate for large engineering tasks

> Русская версия: [Plan-gate-large-engineering-tasks.ru](Plan-gate-large-engineering-tasks.ru)

Issues assigned to an engineering agent and labeled `size:M` or `size:L` enter `planning` mode when they have no `plan` document. The agent must publish the plan and request confirmation bound to the plan revision before implementation begins.

The approval recipient is the first invokable `lead` or `architect` agent in the executor's manager chain, then any such agent of the company, then the agent `adm`. The executor never approves its own plan. Approval returns the issue to standard execution. Small tasks and tasks with an existing plan are unchanged.
