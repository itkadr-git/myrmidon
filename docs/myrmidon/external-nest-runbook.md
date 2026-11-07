# External Nest Creation and Verification Runbook (OPE-10548 PR-1)

> Russian version: [external-nest-runbook.ru.md](external-nest-runbook.ru.md)

Wave 1 operational runbook for provisioning, configuring, verifying isolation, and revoking access for external client nests (OPE-10548, epic OPE-3799 item 1) on the Myrmidon platform.

---

## 1. Architectural Principles and Isolation Boundaries

1. **Isolation Unit — Tenant Company (`company`)**:
   - The external client is isolated at the tenant company level within the shared PostgreSQL database of the board owner. A separate database or standalone instance per client is **not provisioned** (contract decision OPE-10548 §1).
   - All core entities (issues, projects, agents, secrets, channels, budgets) are strictly scoped by `company_id`.
2. **Actor Model**:
   - **Board Owner (`adm`)**: Performs tenant provisioning and management via board owner API/UI (company creation, castes, agents, budget limits, nests).
   - **Stand Operator**: Manages bot execution containers and host secrets.
   - **Client**: End user of the external channel (Telegram group, website widget); has no board user account, and the Myrmidon board UI is never published externally.
3. **Execution Confinement**:
   - The external bot agent is bound to client projects via `agent_nests`. An agent with nests is physically prevented from claiming tasks in other projects or other companies (`agentNestAllowsProject`).

---

## 2. Preconditions

Before provisioning an external nest, verify:
- The Myrmidon server is healthy (`GET /api/health` returns `status: "ok"`).
- Board owner credentials are ready (`MYRMIDON_API_KEY` with instance-admin privileges).
- Client parameters are determined: company name, issue prefix (`issuePrefix`, 2–6 Latin characters, unique on the board), budget caps, and token quotas.

---

## 3. Provisioning Sequence

### Step 1. Create Tenant Company
The tenant company is created using the instance-admin API:

```http
POST /api/companies
Authorization: Bearer $MYRMIDON_API_KEY
Content-Type: application/json

{
  "name": "Acme External Client",
  "issuePrefix": "ACME",
  "budgetMonthlyCents": 50000
}
```

**Expected response:** HTTP 201 Created with company object containing `id` (`companyId`), `issuePrefix: "ACME"`, `budgetMonthlyCents: 50000`.

**Invariants:**
- `issuePrefix` uniqueness prevents collision with existing board tasks (`ACME-1`, `ACME-2`).
- An audit entry `company.created` is emitted.
- `budgetMonthlyCents` establishes the hard monthly financial ceiling in cents.

---

### Step 2. Create External Bot Caste
Register a dedicated caste within the tenant company:

```http
POST /api/myrmidon/companies/:companyId/castes
Authorization: Bearer $MYRMIDON_API_KEY
Content-Type: application/json

{
  "key": "external-bot",
  "nameRu": "Внешний бот",
  "nameEn": "External Bot",
  "description": "Dedicated caste for client-facing bot with nest confinement",
  "color": "sky"
}
```

**Expected response:** HTTP 201 Created with the caste record.

**Invariants:**
- Castes are scoped per company (`castes.db.myrmidon.test.ts: company A's castes are invisible to company B`). The `external-bot` caste of Acme does not leak into other companies.

---

### Step 3. Create Client Project with `defaultCasteKey`
Create the project configured with the default caste:

```http
POST /api/companies/:companyId/projects
Authorization: Bearer $MYRMIDON_API_KEY
Content-Type: application/json

{
  "name": "Acme Support Bot",
  "defaultCasteKey": "external-bot"
}
```

**Expected response:** HTTP 201 Created with project details including `defaultCasteKey: "external-bot"`.

**Invariants:**
- Issues in this project automatically resolve to `defaultCasteKey` when no caste is explicitly provided (`resolveTaskCasteKey`).
- Platform validates caste existence within the target company (`assertProjectDefaultCasteExists`).

---

### Step 4. Create External Bot Agent and Bind Nests (`agent_nests`)

#### 4.1. Create Agent
```http
POST /api/companies/:companyId/agents
Authorization: Bearer $MYRMIDON_API_KEY
Content-Type: application/json

{
  "name": "acme-bot",
  "role": "external-bot",
  "title": "Acme Support Agent",
  "adapterType": "process",
  "capabilities": ["chat", "customer-support"],
  "budgetMonthlyCents": 20000
}
```

**Expected response:** HTTP 201 Created with allocated `agentId`.

#### 4.2. Bind Project Nest
```http
PUT /api/companies/:companyId/agents/:agentId/nests
Authorization: Bearer $MYRMIDON_API_KEY
Content-Type: application/json

{
  "projectIds": [
    "<projectId-from-step-3>"
  ]
}
```

**Expected response:** HTTP 200 OK with the array of bound `projectIds`.

**Invariants:**
- Persisted in `agent_nests(company_id, agent_id, project_id)`.
- Rejects projects from other companies with HTTP 400 (`nests-api.myrmidon.test.ts: another company's project is unknown (400)`).
- The task dispatcher confines this agent to work exclusively within the specified project(s) (`server/src/myrmidon/castes/resolve.ts`).

---

### Step 5. Configure Budget Limits and Token Quotas

#### 5.1. Set Nest Budget Limits (`budget_limits`)
Bind nest-level spending limits to the project:

```http
PUT /api/companies/:companyId/budget-limits/nest/:projectId
Authorization: Bearer $MYRMIDON_API_KEY
Content-Type: application/json

{
  "hardLimitCents": 15000,
  "softLimitCents": 10000,
  "period": "monthly",
  "action": "pause",
  "reason": "Acme initial monthly budget"
}
```

**Expected response:** HTTP 200 OK.

**Invariants:**
- `softLimitCents`: Exceeding this soft threshold triggers an operator warning.
- `hardLimitCents`: Exceeding this hard threshold executes the designated action (`pause` halts the agent, `refuse` rejects incoming tasks).
- All adjustments are logged in `budget_limit_changes`.

#### 5.2. Set Project Token Quotas (`project_token_quotas`)
```http
PUT /api/companies/:companyId/projects/:projectId/token-quotas
Authorization: Bearer $MYRMIDON_API_KEY
Content-Type: application/json

{
  "dailyLimitTokens": 500000,
  "weeklyLimitTokens": 2500000,
  "action": "reject"
}
```

**Expected response:** HTTP 200 OK.

**Invariants:**
- Protects against rapid token exhaustion from external request spikes.
- Model invocations exceeding daily or weekly quotas are rejected (`action: "reject"`).

---

### Step 6. Configure Company Secrets and Provider Bindings
Store provider credentials scoped to the tenant company:

```http
POST /api/companies/:companyId/secrets
Authorization: Bearer $MYRMIDON_API_KEY
Content-Type: application/json

{
  "key": "LLM_API_KEY",
  "value": "<SECRET_KEY_VALUE>",
  "description": "Acme provider API key",
  "provider": "openai"
}
```

**Expected response:** HTTP 201 Created with secret metadata (the `value` property is omitted).

**Invariants:**
- Secret values are encrypted at rest and never exposed in `GET /api/companies/:companyId/secrets`.
- Secrets are injected server-side via `secret-ref` strictly within the `company_id` context (PAP-2394 lesson).
- Decryption and access operations are audited in `secret_access_events`.

---

### Step 7. Configure Chat Ingress Endpoint (`chat_endpoints`)
Register the external channel endpoint:

```http
POST /api/companies/:companyId/chat-endpoints
Authorization: Bearer $MYRMIDON_API_KEY
Content-Type: application/json

{
  "connectionId": "telegram-acme-bot",
  "provider": "telegram",
  "agentId": "<agentId>",
  "projectId": "<projectId>",
  "status": "active",
  "config": {
    "allowedChatIds": ["-1001234567890"],
    "enforceChatMembership": true
  }
}
```

**Expected response:** HTTP 201 Created with endpoint record.

**Invariants:**
- Endpoint is pinned to `companyId`, `agentId`, and `projectId`.
- Source gate validation (`enforceChatMembership` / getChatMember) prior to model invocation prevents spoofed or unauthorized calls (OPE-3852 requirement).

---

## 4. Revocation and Teardown Procedure (Rollback & Revocation)

Upon contract conclusion or security incident, execute the following teardown steps:

### Step R1. Deactivate Chat Endpoint Immediately
Sever incoming external traffic:

```http
PATCH /api/companies/:companyId/chat-endpoints/:endpointId
Authorization: Bearer $MYRMIDON_API_KEY
Content-Type: application/json

{
  "status": "disabled"
}
```
*(Or permanently delete via `DELETE /api/companies/:companyId/chat-endpoints/:endpointId`)*.

### Step R2. Pause or Terminate Agent
Cancel active execution runs:

```http
POST /api/agents/:agentId/pause
Authorization: Bearer $MYRMIDON_API_KEY
Content-Type: application/json

{
  "reason": "Client contract terminated",
  "cancelActive": true
}
```
*(Or invoke `POST /api/agents/:agentId/terminate` for permanent deprovisioning)*.

### Step R3. Invalidate and Delete Secrets
```http
DELETE /api/secrets/:secretId
Authorization: Bearer $MYRMIDON_API_KEY
```
*(Or rotate to a revoked dummy key via `POST /api/secrets/:secretId/rotate`)*.
Subsequent secret resolution fails closed.

### Step R4. Detach Nest from Agent
```http
PUT /api/companies/:companyId/agents/:agentId/nests
Authorization: Bearer $MYRMIDON_API_KEY
Content-Type: application/json

{
  "projectIds": []
}
```
Clears project queue bindings for the agent.

### Step R5. Audit Trail Verification
Verify revocation evidence:
1. Limit change history: `GET /api/companies/:companyId/budget-limits/changes`
2. Secret access audit: `GET /api/secrets/:secretId/access-events`
3. Company activity log: `GET /api/companies/:companyId/activity`

---

## 5. Verification Matrix and Evidence Checklist

| # | Invariant / Requirement | Verification Method | Expected Result | Verified In Code / Tests |
|---|---|---|---|---|
| 1 | Nest Task Confinement | Dispatch task in Company B or Project outside agent's nests | Acme bot is not matched (match score 0, excluded from candidate pool) | `server/src/myrmidon/castes/resolve.ts`, `castes-default-and-nests.db.myrmidon.test.ts` |
| 2 | Cross-Tenant Nest Rejection | `PUT .../nests` with another company's `projectId` | HTTP 400 Bad Request, nest binding rejected | `nests-api.myrmidon.test.ts: another company's project is unknown (400)` |
| 3 | Secret Value Redaction | `GET /api/companies/:companyId/secrets` | Returns list of metadata; `value` is omitted | `board-key-tenant-confinement.test.ts`, `server/src/routes/secrets.ts` |
| 4 | Cross-Tenant Secret Confinement | Attempt to read tenant A secrets using tenant B token/context | HTTP 404 Not Found (non-disclosure) or HTTP 403 Forbidden | `packages/shared/src/myrmidon-secrets.ts`, `agent-cross-tenant-authz-routes.test.ts` |
| 5 | Budget Limit Enforcement | Incur spend exceeding `hardLimitCents` | Agent paused or task execution refused (`refuse`) | `server/src/myrmidon/budget-limits/store.ts`, table `budget_limits` |
| 6 | Token Quota Enforcement | Incur token usage exceeding `dailyLimitTokens` | HTTP 429 Quota Exceeded, model call blocked | `server/src/myrmidon/project-token-quota/routes.ts`, table `project_token_quotas` |
| 7 | Secret Access Auditing | Invoke bot run requiring bound secret | Record created in `secret_access_events` with actor, consumer, issue, outcome | `agent-cross-tenant-authz-routes.test.ts`, table `secret_access_events` |
| 8 | Revocation Audit Trail | Execute teardown steps R1–R4 | Deactivation entries logged in `activity`, `budget_limit_changes`, and key revocation | `agent-cross-tenant-authz-routes.test.ts` |

---

## 6. Readiness Boundaries and Deferred Work

Platform capabilities are structured into three distinct tiers:

### Implemented in Main (Myrmidon Core 1.6.5/1.6.6)
- Shared PostgreSQL with strict table isolation by `company_id`.
- Tenant company creation with `issuePrefix` and `budgetMonthlyCents`.
- Company-scoped castes (`/myrmidon/companies/:companyId/castes`).
- Project-level `defaultCasteKey` resolution (`services/projects.ts`).
- Agent-to-project nest binding via `agent_nests` with cross-tenant guards.
- Project spending caps via `budget_limits` (nest level) and audit trail in `budget_limit_changes`.
- Daily and weekly token rate limits via `project_token_quotas`.
- Encrypted `company_secrets`, secret-ref server injection, and `secret_access_events` audit trail.
- Channel registry via `chat_endpoints` scoped to company.

### Manual Operator Actions
- Provisioning tenant companies via board owner API/UI.
- Setting initial budget limits and token quotas during client onboarding.
- Inputting provider LLM credentials via operator secret setup (pending UI picker).
- Executing deactivation and revocation sequences upon contract teardown.

### Deferred Work (Follow-up Issues)
1. **OPE-10549**: Time-To-Live (TTL) ephemeral secrets (Vault integration, auto-expiring keys).
2. **OPE-9131**: Board UI integration for `myrmidon.personal-bot` plugin (tenant secret picker in web UI, configuration cards).
3. **PR-4 (OPE-10548)**: Website chat widget as a new chat provider over connector contract (OPE-10550) with Origin/domain gating.
4. **PR-5 (OPE-10548)**: Client dialogue history logging, search, and export.

---

## 7. Live Execution Note

A live company creation run on the production `paperclip-server-1` instance was intentionally **not performed** to prevent polluting production storage with test tenants without an approved maintenance window.

All API endpoints, request schemas, constraints, and isolation invariants have been verified directly against the current `itkadr-git/myrmidon` codebase on `main` and are backed by comprehensive automated test suites (`agent-cross-tenant-authz-routes.test.ts`, `board-key-tenant-confinement.test.ts`, `plugin-tenant-isolation.test.ts`, `castes-default-and-nests.db.myrmidon.test.ts`, `nests-api.myrmidon.test.ts`).
