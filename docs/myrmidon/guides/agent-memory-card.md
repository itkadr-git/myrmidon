# Agent memory: the agent card's Memory tab

> Russian version: [agent-memory-card.ru.md](agent-memory-card.ru.md)

The **Memory** tab of the agent card shows the entries of the agent's memory
bank — the same bank the memory plugin writes to during runs. From the tab an
operator can list the entries, export the whole bank as JSON, remove a single
entry and clear the whole bank. The tab lives in the **Runtime** block of the
agent card navigation.

## When the tab is usable

The section is on when the memory service address is known. It comes from
Instance settings → General → Agent memory, else `MYRMIDON_HINDSIGHT_API_URL`,
else `MYRMIDON_BOT_HINDSIGHT_API_URL` (the same service as the bots use). The
API key is optional: name the company secret holding it (the same panel, or
`MYRMIDON_HINDSIGHT_KEY_SECRET`) only if the service requires one.

See [SETTINGS.md](../SETTINGS.md) for the exact semantics. The settings are
read per request: changing them takes effect without a restart.

While no address is known, the tab shows the status line "Agent memory
is not enabled on this instance." and its data routes answer 503. The settings
are instance-wide; the memory bank itself is resolved per agent.

## Which bank the tab shows

The tab shows the bank the agent actually uses, resolved by the same rule the
memory plugin fork applies:

1. the agent card's `adapterConfig.hindsight.bankId`, else
2. the memory plugin configuration's `bankByAgentId` entry for the agent, else
3. the agent has no bank — the tab shows "This agent has no memory bank
   configured" (a state, not an error).

An operator cannot point the tab at a bank the agent does not use.

## What the plugin writes into the bank

The memory plugin (`packages/plugins/hindsight-paperclip`) does not write one
entry per ticket comment. An agent's comments wait in run-scoped plugin state,
and when the run finishes the plugin retains **one consolidated digest per
bank**: a document headed `Run <runId> digest` listing the run's comments with
author and ticket, with metadata `kind: "run-digest"`, `runId`, `agentIds`,
`issueIds` and `commentCount`. Duplicate comment ids collapse; bodies under
200 characters and board-machinery comments (a milestone heading, a status
change, a wake notice, a `Review:` verdict) are dropped. In the tab's list
these digests appear as ordinary entries — one per run, not one per comment.

A comment outside a run — a human's, or an event that carries no run id — is
retained immediately, as before, because it is new input for whichever run
picks the ticket up next. A failed retention is a warning in the plugin log;
a run never fails because of memory.

Automatic retention is switched by the plugin instance configuration field
`autoRetain` (default on); off means no automatic retention at all, and a
buffered digest is discarded when the run finishes.

Run-start recall is gated by the plugin instance configuration field
`recallOnRunStart` (not an environment variable): `new-issue` (the default)
searches the agent's bank only when the agent has not already searched for
this ticket, so repeated wakes of one ticket do not repeat the same search;
`always` recalls on every run start (the previous behaviour); `never` turns
run-start recall off. An absent or unknown value reads as `new-issue`. The
`hindsight_recall` tool still searches on demand, regardless of this field.

## What the tab offers

- **Entry list.** Fifty entries per page, **Newer** / **Older** paging. Each
  entry shows its text, fact type, state (shown when not `valid`), date and
  tags.
- **Export bank.** Downloads the whole bank as one JSON file
  (`agent-<agent-id>-memory.json`). A bank larger than 5000 entries is
  truncated at 5000, and the notice says how many entries were exported out of
  the total.
- **Remove an entry.** Each entry that is not already invalidated has a reason
  field and a **Remove** button; the button stays disabled until a reason is
  typed. Removal is a soft invalidation with that reason: the entry stays in
  the service's audit as invalidated and the removal is reversible there. The
  list shows invalidated entries with their state, without the removal
  controls.
- **Clear the whole bank.** A destructive action in a separate block: it is
  enabled only after typing the agent's id into the confirmation field. The
  result notice reports how many entries were removed.

Only board actors with access to the agent's company can use the tab; an agent
key cannot read or change any memory bank, and an agent of another company is
indistinguishable from a missing one (404).

## Activity log

Every export, removal and bank clear writes a row to the company's activity
log with an action of the `myrmidon.agent.memory.*` family. The row carries
the bank id, the memory id and the removal reason where applicable — never
the texts of the memory entries.
