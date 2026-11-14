---
title: "Run cap without commit"
issue: "OPE-13080"
author: "adm-dev-eng-26"
date: "2026-11-14"
---

### EN
Added automatic run cap when consecutive completed runs on an issue do not advance the PR head commit (`general.processes.taskRunsWithoutCommitLimit`, default: 4, 0 = disabled).
When reached:
- Automatic re-wakes and continuations for the task are skipped.
- Task status transitions to `blocked` with a summary of recent runs and current PR head SHA.
- Project lead (or assignee's manager, or adm) is woken with the escalation details.
- Counter resets on new commit in the PR or manual unblock.

### RU
Добавлен потолок прогонов на задачу без нового коммита в ветку PR (`general.processes.taskRunsWithoutCommitLimit`, по умолчанию: 4; 0 — выключено).
При достижении:
- Новые автоматические побудки и продолжения по задаче не ставятся (skip).
- Задача переводится в статус `blocked` с описанием причины, сводкой последних прогонов и sha PR.
- Лид проекта (или руководитель исполнителя, или бот adm) получает побудку со сводкой.
- Счётчик сбрасывается при новом коммите в ветку PR или ручном снятии блока с задачи.
