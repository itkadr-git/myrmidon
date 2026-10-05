# Autonomy Matrix: Instructions Change Control

The autonomy matrix controls which actions each agent role can perform without human oversight. This guide explains how the `change_instructions` action class controls modifications to agent instructions.

## Overview

Starting with version 1.6.2, the autonomy matrix includes a `change_instructions` action class that governs:

- Changing agent instructions path (`PATCH /agents/:id/instructions-path`)
- Updating agent instructions bundle (`PATCH /agents/:id/instructions-bundle`)
- Deleting files from agent instructions bundle (`DELETE /agents/:id/instructions-bundle/file`)
- Rolling back agent instructions revisions (`POST /agents/:id/instructions-revisions/:revisionId/rollback`)

## Action Classes

The `change_instructions` action class controls modifications to an agent's core instructions. When an agent attempts to modify its own or another agent's instructions, the system checks the autonomy matrix to determine whether the action is allowed, requires approval, or is forbidden.

### Verdict Types

Each (role, action class) pair in the matrix has one of three possible verdicts:

- **`allowed`**: The agent can change instructions without human intervention
- **`approval_required`**: The action is denied with 403 and the error code `autonomy_approval_required` until the holding-action conveyor (approval cards for invocation-less routes) ships; a follow-up will replace the deny with a held action
- **`forbidden`**: The agent is prohibited from changing instructions (returns 403)

## Enforcement Points

The autonomy matrix is enforced at four key routes:

1. `PATCH /api/agents/:id/instructions-path`
2. `PATCH /api/agents/:id/instructions-bundle`
3. `DELETE /api/agents/:id/instructions-bundle/file`
4. `POST /api/agents/:id/instructions-revisions/:revisionId/rollback`

For each of these routes, the gate (`dbAutonomyGate(db).decide(req, "change_instructions")`)
runs before any write: `forbidden` returns 403 with the error code `autonomy_forbidden`;
`approval_required` returns 403 with the error code `autonomy_approval_required`. A denied
request never rewrites instructions, bundles, or revisions. The matrix is stored in
`instance_settings.general.myrmidonAutonomy` and read on every request — a matrix edit in
the UI applies immediately, without a server restart.

## Configuration

Configure the autonomy matrix through the board UI or API. The matrix contains:

- Rules specifying (role, action class) → verdict mappings
- Default verdicts for action classes without specific rules
- Version tracking for optimistic concurrency control

## Board Access

Board (human) users are not subject to autonomy matrix restrictions and can always modify agent instructions regardless of the matrix configuration.