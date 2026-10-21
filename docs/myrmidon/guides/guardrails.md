# Guardrail modes

Guardrail modes are stored in `guardrail_mode_settings` and apply per rule. Rules are `secrets_output`, `pii_output`, and `prompt_injection_input`. Modes are `flag_only`, `mask`, and `block`.

Resolution is agent override, then caste override, then company override, then the safe `flag_only` default. `GET /api/myrmidon/companies/:companyId/agents/:agentId/guardrails/modes` returns each effective mode and its source. Board users can update a setting with `PUT /api/myrmidon/companies/:companyId/guardrails/modes`.

The effective-value cache is invalidated after writes and has a short TTL. A setting change is therefore visible without a server restart.
