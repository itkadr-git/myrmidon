# Replay-block triage

A settled execution-reconciliation replay block is now visible in the attention feed as a high-severity `replay_blocked` card. The card identifies the responsible lead when the assignee reports to one, otherwise the company's default board operator, and carries a 24-hour triage deadline. It is computed from the live blocked hold and disappears when the hold is cleared.

Changing an issue's executor clears the previous executor's settled replay hold in the same transaction, records the reassignment reason in activity, and replans the new executor's parked wake.
