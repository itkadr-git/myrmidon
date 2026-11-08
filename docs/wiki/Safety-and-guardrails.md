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
- **Pause / resume / wake** (`pause_wake_agents`): the three agent
  lifecycle routes check the matrix before acting. Enforced on the main
  development line; not part of the 1.6.5 release line (backport pending in
  [#910](https://github.com/itkadr-git/myrmidon/pull/910)).
- **Delete** (`delete`, 1.6.2): DELETE endpoints check the matrix and refuse
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

## Runtime guardrails and fleet isolation (1.7 SETTINGS-TO-UI)

Starting with Myrmidon 1.7, execution safety guardrails and container fleet boundaries can be configured dynamically without restarting the server:

- **Egress traffic control** (`bot_egress_mode`): Controls whether bot container network traffic is unproxied (`off`) or routed through the egress proxy with full request audit logging (`log`).
- **Tool circuit breaker** (`tool_breaker_*`): Halts tool execution loops automatically when consecutive tool failures cross threshold limits within a rolling time window.
- **Tool execution timeouts** (`tool_timeout_*`): Enforces maximum tool runtime limits and warns on slow tool execution.
- **Host environment filtering** (`run_env_allow`): Restricts which host environment variables can be passed into agent runs.
- **Container isolation boundaries**:
  - Image allowlist (`bot_image_allowlist`): Restricts runner containers to verified images.
  - Mount source allowlist (`bot_mount_sources`): Restricts host directory mounts.
  - Container GitHub env allowlist (`bot_container_github_env_allowlist`): Restricts sensitive token forwarding.
  - Autonomous YOLO mode (`bot_yolo`): Toggles whether agents bypass interactive confirmation.
- **Precedence and UI Confirmation**:
  - Precedence: `ui` (saved setting) > `env` (environment variable) > `default` (built-in default).
  - Updating allowlists or enabling YOLO mode requires explicit confirmation in the UI modal dialog to protect against accidental security degradation.
  - Full details: [Settings in the interface](Settings-in-the-interface.md#guardrails-panel-instance--general).

## In detail

- [Autonomy matrix: instructions change control](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/guides/autonomy-matrix-instructions.md)
- [Autonomy matrix: pause, resume, wake enforcement](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/guides/autonomy-pause-wake-enforcement.md)
- [Autonomy matrix: delete enforcement](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/guides/autonomy-delete-enforcement.md)
- [Emergency stop for drained-pause runs](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/guides/emergency-stop.md)
- Matrix storage and API: [SETTINGS.md](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/SETTINGS.md), sections «AUTONOMY-MATRIX» and «GUARDRAILS»
