# Agents and roles

> Русская версия: [Agents-and-castes.ru](Agents-and-castes.ru)

Myrmidon runs work as a team of agents. Each agent has a record on the board
with its role, its model, its instructions, its budget and its state — and,
in container mode, its own isolated runtime.

## What an agent is

An agent is a board record plus a runtime. The record holds:

- a **role** (a caste key such as `coder` or `reviewer`) that decides which
  queue the agent claims work from, which action classes the
  [autonomy matrix](Safety-and-guardrails) applies to it, and how much of
  the company's budget it may spend;
- the **model** the agent's runs use (from the company's registered
  providers — see [Models and budgets](Models-and-keys));
- an **instructions bundle** — the files the agent reads at every run (its
  entry file plus supporting documents);
- a **memory bank** (optional) and its own API key and secrets.

The agent card is the operator's window into all of this: the card's tabs
show the state, the memory, the instructions, the container and the cost of
recent runs.

## The container runtime

An agent with the `hermes_gateway` adapter can run inside a Docker container
the board manages. The card's **Container** section holds the container
settings and shows the live state. A bot container:

- has exactly one writable volume for its own data, with a per-bot disk
  quota so one runaway clone cannot fill the host disk;
- mounts shared read-only caches (pnpm packages, Go modules, git objects) so
  the downloads are kept once per host, not once per bot;
- reaches the board through its own gateway key, and reaches the outside
  through the fleet proxy (see [Operations and maintenance](Server-maintenance)).

## Instructions with history

Every change to an agent's instructions bundle — a file put, a delete, a
bundle patch — is snapshotted as a full revision. Any earlier revision can
be restored through the API, and the restore itself is another revision, so
nothing is lost. The
[autonomy matrix](Safety-and-guardrails) controls whether an agent may
change instructions at all or only with an approval.

## Memory

The agent card's **Memory** tab lists the entries of the agent's memory bank
— the same bank the agent's memory tooling writes to during runs. From the
tab an operator can list entries, export the whole bank as JSON, remove a
single entry or clear the bank.

## Recovery instead of babysitting

The board watches its agents and repairs what breaks:

- an agent left in the `error` status after a failed run is resumed
  automatically with a backoff (1, 5, 15 minutes); when the resumes keep
  failing the card is escalated to the attention desk for an operator;
- a run whose recorded progress has not moved past the stall threshold (20
  minutes by default) is interrupted, its task goes back to `todo` and the
  assignee is woken — the board does not wait for a hard timeout to notice
  a stuck run.

## In detail

- [Bot container: the Container section](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/guides/bot-container-card.md)
- [Agent memory card](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/guides/agent-memory-card.md)
- [Agent instructions: revision history and restore](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/guides/agent-instructions-revisions.md)
- [Automatic resume from error](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/guides/auto-resume.md)
- [Run stall detection](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/guides/run-stall.md)
- [Board administrator toggle](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/guides/agent-board-admin.md)
- [Parallel helper subagents](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/guides/parallel-helpers.md)
