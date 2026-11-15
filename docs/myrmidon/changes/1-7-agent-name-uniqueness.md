## changelog-en

### Agent names are unique within a company without regard to case (1.7 AGENT-ADDRESS)

- Agent creation and rename requests reject a name already used by another agent in the same company, including terminated agents, with HTTP 409 and error code `agent_name_conflict`.
- An agent may retain its own name or change only its letter case. The same name remains valid in another company.
- Creation no longer adds a numeric suffix automatically, and existing duplicate names are not migrated or renamed.