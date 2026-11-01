# Event priority classification

Run-log event priorities are assigned by `classifyEventPriority` in
`server/src/myrmidon/event-priority/policy.ts`. Lower P-number values are more
urgent. This is a classification for consumers that batch events; it does not
itself wake an agent or alter event persistence.

| Event type | Priority | Reason |
| --- | --- | --- |
| `native.recovery.transition` | P0 | Recovery decision or graceful restart evidence |
| `native.local_process_stopped` | P0 | Confirms process termination for safe recovery |
| `native.stopped_text_turn_verified` | P0 | Verifies a stopped turn before replacement |
| `native.process_start_requested` | P1 | Process launch has begun |
| `native.process_identity_recorded` | P1 | New process identity is established |
| `lifecycle` | P1 | Run/task state transition |
| `run.startup.step` | P2 | Startup step result useful for operational diagnosis |
| `run.phase.timing` | P3 | Timing diagnostic, not a control decision |
| `output` | P3 | Routine run output |
| `log` | P4 | Informational detail |
| Any unlisted event type | P4 | Safe default for extension and legacy event types |

The mapping is intentionally case-sensitive and exact: producers own event type
names; unknown values do not inherit urgency from a partial match. Unit tests
exercise every listed mapping plus unknown and malformed-case inputs.
