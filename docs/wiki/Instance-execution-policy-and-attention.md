# Instance execution policy and attention feed settings (1.6.6 SETTINGS-UI S)

> Русская версия: [Instance-execution-policy-and-attention.ru](Instance-execution-policy-and-attention.ru)

This guide documents the read-only execution policy badge and the Attention Feed settings panel located in **Settings > Instance > General** (audit OPE-11230 / OPE-11234).

## Execution policy (`general.executionMode`)

### Overview and restrictions
The execution policy represents the runtime execution environment target configured for the Myrmidon instance.
- **Location**: Displayed at the top of the **Settings > Instance > General** page.
- **Read-only badge**: The execution mode is platform/cloud-owned and cannot be edited or toggled via the user interface. It is rendered as an outline badge (`execution-mode-badge`).
- **Visibility**: If hidden via instance configuration (`hiddenSettings` contains `instance.general.executionMode`), the execution policy section is completely omitted from the UI.

### Modes and default behavior
- **`any`** (default): Unrestricted runtime execution target. Agents run in their standard configured environments.
- **`kubernetes`**: Forces all agent execution into the managed Kubernetes sandbox.
- When no explicit mode is configured in `instance_settings.general`, the interface defaults to displaying `any`.

---

## Attention Feed settings (`general.attention*`)

### Overview
The **Attention feed** panel on the **Settings > Instance > General** page allows instance administrators to view and configure the operational windows used when assembling the company attention feed (`GET /api/myrmidon/attention-feed`).

### Stored settings and bounds
Settings are stored in `instance_settings.general` and managed via `GET`/`PATCH /api/myrmidon/attention-feed`:

| Setting | Type / Bounds | Built-in default | Description |
|---|---|---|---|
| `attentionFailedRunHorizonDays` | Integer, 1 to 365 | `7` | How far back (in days) the attention feed looks for unresolved failed or timed-out runs. |
| `attentionFeedCacheTtlSeconds` | Integer, 0 to 300 | `60` | Duration (in seconds) that the assembled attention feed is cached in-memory per company. Setting `0` disables caching. |

### Operational behavior
- **Access control**: Any board member can read the settings; updating them requires instance administrator privileges.
- **Partial updates**: `PATCH` accepts partial payloads — updating one window leaves the other untouched.
- **Auditing**: Every update generates an audit entry for the company.
- **Hot reload**: Changes take effect immediately upon the next attention feed retrieval; no server restart or redeploy is required.
