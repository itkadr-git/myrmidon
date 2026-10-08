# Autonomy and guardrails

> Русская версия: [Safety-and-guardrails.ru](Safety-and-guardrails.ru)

Autonomy in Myrmidon is not a slogan, it is a table: which action classes
each role may perform on its own, which need a human's approval, and which
are forbidden outright.

## The autonomy matrix

The matrix maps role × action class to one of three verdicts: `allowed`,
`approval_required`, `forbidden`. It is edited in the board UI (Company
settings → Autonomy) and stored as instance settings, so a matrix edit takes
effect without a restart. The factory default is every cell `allowed` —
zero behaviour change until an operator edits it.

Enforced seams include:

- **Instructions** (`change_instructions`, 1.6.2): changing an agent's
  instructions path or bundle, deleting a bundle file, rolling back a
  revision. `forbidden` refuses with 403 `autonomy_forbidden`;
  `approval_required` holds the change for an approval; denied requests
  never rewrite instructions or create revisions.
- **Pause / resume / wake** (`pause_wake_agents`, 1.6.4): the three agent
  lifecycle routes check the matrix before acting.
- **Delete** (`delete`, 1.6.4): DELETE endpoints check the matrix and refuse
  roles whose `delete` cell is `forbidden`.

Board administrators are not subject to the matrix.

## Guardrails: flagging untrusted input

The guardrails layer flags prompt-injection attempts in externally authored
input before a run reads it. It is off by default: without
`MYRMIDON_GUARDRAILS_INJECTION_ENABLED` the wake queue stores exactly what
it stored before — no markers, no flag, no event. When enabled, an
externally authored queued comment's text is wrapped in
`<untrusted-data>…</untrusted-data>` markers inside the wake payload, and a
heuristic scan sets a `flagged` marker when the score crosses the threshold
(`MYRMIDON_GUARDRAILS_INJECTION_SCORE`, default 0.6). The layer flags; it
does not block.

## Emergency stop

An operator pause lets the agent's active runs finish (drained pause). For
the runs a draining pause left finishing, the emergency stop is the
operator's immediate lever: `POST /api/myrmidon/agents/:id/emergency-stop`
stops them at once. It exists since release 1.1.2 and adds nothing to
configure.

## In detail

- [Autonomy matrix: instructions change control](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/guides/autonomy-matrix-instructions.md)
- [Autonomy matrix: pause, resume, wake enforcement](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/guides/autonomy-pause-wake-enforcement.md)
- [Autonomy matrix: delete enforcement](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/guides/autonomy-delete-enforcement.md)
- [Emergency stop for drained-pause runs](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/guides/emergency-stop.md)
- Matrix storage and API: [SETTINGS.md](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/SETTINGS.md), sections «AUTONOMY-MATRIX» and «GUARDRAILS»
