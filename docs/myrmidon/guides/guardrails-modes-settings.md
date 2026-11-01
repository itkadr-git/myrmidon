# Guardrail enforcement modes, settings, and journal UI

myrmidon(1.7-GRD-MODES): configurable per-rule enforcement modes (`flag`, `mask`, `block`) with precedence resolution, hot reload without process restart, and a filtered firing journal.

## Enforcement modes

Each guardrail category (`secret`, `pii`, `injection`) supports three enforcement modes:

- **flag** (default): detects and records the hit in the guardrail firing journal. Output and input are published unmodified.
- **mask**: replaces detected matching spans with `[masked]` before publication or comment queuing.
- **block**: withholds the run output or queued comment entirely. For run output, a safe refusal message is published instead (`[Guardrail block: content withheld by policy]`), ensuring no secrets or sensitive data leak. For queued comments with injection detected, the queue action is refused safely with `GUARDRAIL_INJECTION_BLOCKED`.

## Resolution precedence

Effective modes resolve with strict hierarchy:

1. **Environment force override**: `MYRMIDON_GUARDRAILS_FORCE_MODE_<RULE>` (e.g. `MYRMIDON_GUARDRAILS_FORCE_MODE_SECRET=block`) overrides all settings for that rule.
2. **Per-agent override**: settings configured specifically for the agent (`instance_settings.general.guardrailModes.agents[agentId][rule]`).
3. **Caste override**: settings configured for the agent's caste/role (`instance_settings.general.guardrailModes.castes[caste][rule]`).
4. **Company-wide mode**: company-level configuration (`instance_settings.general.guardrailModes.company[rule]`).
5. **Default**: `flag` for all rules when no override is set.

The effective resolution API (`GET /api/myrmidon/companies/:companyId/guardrails/effective`) returns the resolved mode together with its resolution source (`env`, `agent`, `caste`, `company`, or `default`).

## Hot settings readback and persistence

Guardrail modes are persisted in `instance_settings.general.guardrailModes` via validated authorized routes:
- `GET /api/myrmidon/companies/:companyId/guardrails/settings`
- `PUT /api/myrmidon/companies/:companyId/guardrails/settings`

Changes take effect immediately on subsequent run outputs and queued comment operations without server restart. Existing instance settings (e.g. WIP limits, behavior settings) are safely preserved across updates.

## Safety bounds and journal

- **Scan bound**: Run output inspection scans up to the first 262,144 characters.
- **Event cap**: At most 20 guardrail events are written per run to protect the database.
- **Redaction**: Stored snippets are clamped to 200 characters and shape-redacted.
- **Journal API and UI**: The firing journal (`GET /api/myrmidon/companies/:companyId/guardrails/journal`) supports equality filters for rule `kind`, `severity`, `surface`, and `runId`. The UI provides interactive filter controls with full English and Russian localization.
