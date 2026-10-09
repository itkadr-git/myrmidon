## changelog-ru

### 1.6.5 F-26 SWARM (OPE-6608, финальное ревью): касты в ребалансе супервизора, остатки пилота, реальный путь побудки

- Матчер ребалансировки супервизора (`swarm-claim-supervisor/routes.ts`) собирается со справочником
  каст (`createCasteDirectoryReader`), как проход страховки и API захвата: освобождённая супервизором
  задача не уходит агенту касты с `swarmEligible=false` и учитывает потолок касты.
- Остатки пилота убраны: подзаголовок и колонки отчёта пилота в локалях страницы супервизора,
  абзац про «swarm claim pilot» и побудку `swarm_claim_queue` в навыке `paperclip` (теперь: доска сама
  назначает задачу свободному агенту касты и будит его на неё), строки в README.
- Тест на встроенной БД с реальным путём побудки: сопоставитель назначает задачу, побудка идёт
  `queueIssueAssignmentWakeup` → `heartbeat.wakeup`, прогон по задаче создаётся и не закрывается как
  `skipped` / `issue_reassigned`.

## changelog-en

### 1.6.5 F-26 SWARM (OPE-6608, final review): castes in the supervisor rebalance, pilot leftovers, the real wake path

- The supervisor's rebalance matcher (`swarm-claim-supervisor/routes.ts`) is built with the caste
  directory (`createCasteDirectoryReader`), like the sweep and the claim API: a task released by the
  supervisor is not handed to an agent of a `swarmEligible=false` caste and respects the caste ceiling.
- Pilot leftovers are gone: the subtitle and the pilot report columns in the supervisor page locales,
  the "swarm claim pilot" paragraph and the `swarm_claim_queue` wake in the `paperclip` skill (now: the
  board itself assigns a task to a free agent of the caste and wakes it on that task), README lines.
- An embedded-Postgres test with the real wake path: the matcher assigns the task, the wake goes
  `queueIssueAssignmentWakeup` -> `heartbeat.wakeup`, a run for the task is created and is not closed as
  `skipped` / `issue_reassigned`.
