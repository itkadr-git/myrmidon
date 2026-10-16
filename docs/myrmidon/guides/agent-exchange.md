# Discussion rooms on issue cards (1.7 AGENT-EXCHANGE-A)

A discussion room lets 2–4 agents on different models debate a question
directly on the issue card, without turning it into a comment thread:

1. **Open** — the owner (or an agent of the company) posts the topic plus the
   roster: 2–4 participants, each pinned to a `provider/model`, and an
   optional finisher (defaults to the first participant).
2. **Independent first answers** — round 1 calls every participant with only
   the topic in view. Nobody sees another participant's answer before posting
   their own; the first round is one parallel batch.
3. **Rounds** — later rounds see every previous answer. Each round is one
   `POST …/rounds` call; the room never runs ahead by itself.
4. **Stop valve** — the owner (or the opener) stops the room at any point.
   A stopped room makes no further model calls.
5. **Summary** — finalizing calls the finisher once, then writes the result
   as an issue document (`agent-exchange:<roomId>`) with the total token
   count and the cost in cents, computed from the model-provider price
   table.

## API

All routes live under `/api/myrmidon/agent-exchange` and follow the standard
access rules (board or company member for reads and opens; only the opener,
a company admin or an agent of the company may stop).

| Route | Purpose |
|---|---|
| `GET /settings` | The resolved room rules with the per-key source (`settings` / `env` / `default`). |
| `PATCH /settings` | Save the room rules (instance admin; applies without a restart). |
| `POST /issues/:issueId/rooms` | Open a room: `topic`, `participants[]` (`agentId?`, `provider`, `model`), optional `finisher`. Opens with the independent first round already run. |
| `GET /issues/:issueId/rooms` | The rooms of one issue. |
| `GET /rooms/:roomId` | One room with the full round grid (every cell: status, text, tokens, cost). |
| `POST /rooms/:roomId/rounds` | Run the next round (until the round cap or the token budget). |
| `POST /rooms/:roomId/finalize` | Call the finisher and write the summary document with the cost. Idempotent. |
| `POST /rooms/:roomId/stop` | The stop valve: the room freezes, no further model calls. |

## Guardrails

- Room size is 2–4 participants (`maxParticipants` caps the roster).
- Rounds are capped (`maxRounds` counts the rounds after round 1).
- A per-room token budget (`tokenBudget`) stops the room with
  `stopReason = "budget"` — the room refuses new rounds and can only be
  finalized.
- A participant that errors (timeout, provider failure) is marked `error` in
  its grid cell; the room goes on with the rest.
- The master switch `enabled` is off by default: opening a room answers
  `403 feature_disabled` until the owner turns rooms on.

## Settings

Instance → General → «Discussion rooms (agent exchange)», or
`GET`/`PATCH /api/myrmidon/agent-exchange/settings`. Every value shows its
source; a saved value wins over the environment, the environment wins over
the default (the same precedence as the other myrmidon settings). The
environment variables (`MYRMIDON_AGENT_EXCHANGE_*`) force the values on an
instance that never saved its settings — see
[SETTINGS.md](../SETTINGS.md#17--agent-exchange-a-discussion-rooms-on-issue-cards).

A settings read failure fails safe-closed (rooms treated as disabled).

## Data model

Two tables (`packages/db/src/migrations/0307_agent_exchange_rooms.sql`):
`agent_exchange_rooms` freezes the roster, the finisher and the ceilings at
open; `agent_exchange_messages` is the round grid — one cell per participant
per round, which is what enforces independent first answers.

## Limits of part A

DEBATE-ASYM roles and the judge are a later part: this part ships the room,
the independent first answers, the stop valve and the costed summary.
