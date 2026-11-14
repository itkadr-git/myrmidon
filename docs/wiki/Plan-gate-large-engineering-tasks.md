# Plan gate for large engineering tasks

Issues assigned to an engineering agent and labeled `size:M` or `size:L` enter `planning` mode when they have no `plan` document. The agent must publish the plan and request confirmation bound to the plan revision before implementation begins.

The project lead is the approval recipient when invokable. If no invokable project lead exists, approval is routed to the company `adm` agent. Approval returns the issue to standard execution. Small tasks and tasks with an existing plan are unchanged.
