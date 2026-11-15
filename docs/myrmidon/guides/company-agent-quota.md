# Company agent quota (subscription tier limit)

> Russian version: [company-agent-quota.ru.md](company-agent-quota.ru.md)

Each company has a limit on the number of agents it can run, set by its
subscription tier. The limit is enforced when an agent is created
(`POST /api/companies/{companyId}/agents`), so a company cannot grow its
fleet past what its tier allows.

Feature ID: 1.7 TIER-QUOTA-CHECK (OPE-12092). The quota values themselves
live in the `company_tiers` table, shipped by the 1.7 TIER-SCHEMA migration
(OPE-12091).

## What is counted

The quota counts **active agents** of the company: every agent row that
belongs to the company and is not `terminated`. Paused and errored agents
still occupy quota slots — they exist and can be resumed — while terminated
agents do not.

## What happens over the quota

When the current active agent count has reached or exceeded the quota,
creation is rejected with:

- HTTP `403 Forbidden`
- response body `{ "error": "...", "code": "quota_exceeded" }`
- a message naming the tier, the current active agent count and the quota,
  for example: `Agent quota exceeded for company tier 'free': current
  active agents (5) reached or exceeded quota (5)`.

Within the quota, creation proceeds as before. The check is also applied
inside the agent-creation service, so it covers both API requests and
internal callers that create agents through the service.

## Default tier and quota

A company without a row in `company_tiers` gets the built-in defaults:

- tier: `free`
- agent quota: `5`

The defaults apply only once the `company_tiers` table is deployed; see the
next section for what happens before that. A stored quota of `0` is valid
and means the company cannot create any new agents.

## Behavior when `company_tiers` is not deployed yet

The `company_tiers` table ships with the 1.7 TIER-SCHEMA migration
(OPE-12091). On an instance where that migration has not been deployed, the
table does not exist and the quota check stays **dormant**: every agent
creation passes, and no company gets a surprise 403 from a schema it does
not have yet. This is deliberate — a rollout of the application must never
break agent creation on instances that lag behind on database migrations.

Once the migration is deployed, the check activates: companies with a
`company_tiers` row are limited by their stored quota, and companies
without a row fall back to the `free`/`5` defaults above.

## Read failures are fail-closed

A database read failure (connection error, permissions problem) is neither
"table missing" nor "company has no tier row". Read failures propagate as
errors — they never get interpreted as an empty quota state that would
silently widen what a company is allowed to do. If you see unexpected 500s
during agent creation after deploying 1.7, check database connectivity and
that the 1.7 TIER-SCHEMA migration (OPE-12091) actually ran.

## Where it is enforced

- Route middleware on `POST /api/companies/{companyId}/agents`, running
  before request validation
  (`server/src/modules/agents/index.ts`, `createAgentQuotaMiddleware`).
- A second check inside the agent-creation service
  (`server/src/services/agents.ts`).

Both paths answer from the same module
(`server/src/modules/agents/`): the pure domain policy
(`domain/quota.ts`), the Postgres tier reader
(`adapters/postgres.ts`) and the assert use case
(`application/use-cases.ts`).
