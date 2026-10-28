# ADM Instruction: Managing the "Ideas" Project and Owner Dialogue (OPE-9760, 1.6.7)

## 1. Dedicated "Ideas" Project on Board
- A dedicated "Ideas" project is maintained on the Myrmidon board.
- Purpose: separate ideas and spontaneous proposals from owner Alex and agents from planned release cycles.
- Cards in the project:
  - Must not have an assignee (`assigneeAgentId = null`, `assigneeUserId = null`).
  - Must not have a deadline (`dueDate = null`).
  - Must include mandatory origin fields: session/chat id, date, author.

## 2. Same-Turn Idea Capture Rule
- Any idea or thought from Alex ("would be good to...", "should consider..."), not immediately turned into a sprint task, is captured as a card in the "Ideas" project in the very same turn.
- Losing owner suggestions or asking the owner to repeat is prohibited.

## 3. Weekly Review Routine
- A weekly routine is scheduled on the board with cron expression `0 10 * * 1` (Mondays at 10:00 UTC).
- Lead (`adm-dev-lead`) or architect (`adm-architect`) reviews accumulated ideas:
  1. **Move to release**: transfer to release project with assigned engineer, priority, and timeline.
  2. **Decline**: cancel/close with explicit explanation.
  3. **Retain**: keep in the "Ideas" project for further context gathering.
- SLA requirement: each new idea is either triaged or less than 7 days old.
