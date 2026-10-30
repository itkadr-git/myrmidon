# Guardrail run-output limits and redaction

myrmidon(1.6-GRD): run-output guardrail inspection is bounded before it writes events.

- Scanning is limited to the first 262,144 characters of the final run text.
- At most 20 guardrail events are written for one run. Detection totals remain
  visible in the returned result, while the write cap protects the event store.
- Stored snippets are clamped to 200 characters and shape-redacted before they
  are persisted. Raw email addresses and token-shaped values must not enter the
  event record.
- The feature remains flag-only; this delta does not add or alter enforcement
  modes, resolver precedence, filters, or UI controls.

Regression coverage exercises the scan boundary, event cap, redaction shape,
and snippet clamp. The mode/resolver/filter/UI line is delivered independently
by PR #513 and is intentionally not duplicated or rewritten here.

## Configuration

The existing `MYRMIDON_GUARDRAILS_OUTPUT_ENABLED` switch controls whether the
run-output hook is active. The limits are code-level safety bounds, not runtime
settings.
