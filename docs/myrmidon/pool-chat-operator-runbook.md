# Pool-chat: operator acceptance runbook

Runbook for an authorized operator who enables the pool-chat module boundary
(OPE-8207, `MYRMIDON_POOL_CHAT_ENABLED`). This is a deployment runbook, not a
claim of live-pool qualification: the implementation and CI tests use a fake
transport, and no live run has been performed. The change summary is in
[changes/pool-chat-adapter.md](changes/pool-chat-adapter.md).

Russian version: [pool-chat-operator-runbook.ru.md](pool-chat-operator-runbook.ru.md).

## 1. Required sequence

1. Keep `MYRMIDON_POOL_CHAT_ENABLED` unset (or any value other than `1`) while
   deploying. The routes are not mounted and no provider call can happen.
2. The schema ships as migration `0411_pool_chat_module_instance` (four tables:
   module instances, requests, request attempts, quota reservations). Confirm it
   is applied once on the target database and check the tables, foreign keys and
   unique indexes before enabling anything.
3. Create one module instance per deployment/module: `provider`,
   `config.endpoint`, `config.allowedModels`, enabled account records
   (`accountRef`, `provider`, `enabled`, integer `quotaUnits` or `null`,
   integer `usedUnits`) and a non-secret `credentialSecretName`. Store the
   provider key in the secret store under that exact name; never put a key in
   module JSON, logs, fixtures or comments. Configure ChatGPT and Google
   endpoints independently and check that each endpoint matches its provider.
4. Grant the `chat:invoke` permission to each service principal, scoped to the
   exact `moduleId`, `channelId` and `subjectId` tuple. No role grants it by
   default, and a grant that does not bind all three is rejected.
5. Quota is a lifetime token budget per account. The effective usage is the
   configured `usedUnits` baseline plus the ledger (reserved or settled units of
   `dispatching`, `sent` and `uncertain` attempts). Reset it by raising
   `quotaUnits` or lowering `usedUnits` through the approved operator
   procedure; never by deleting ledger rows.
6. Before enabling the flag, reconcile attempts in `dispatching` and
   `uncertain` and quota rows in `reserved`. There is no automatic recovery or
   retry: resolve each provider outcome with the provider request reference
   and the deployment records, then settle or release the reservation.
7. With the flag still off, run CI at the exact deployed head and record the
   commit SHA and all required checks. Enable the flag only after the checks
   and the staging acceptance below pass. Roll back by disabling the flag
   first; keep the ledger for investigation.

## 2. Contract acceptance matrix

| Case | Expected evidence | Live, operator only? |
| --- | --- | --- |
| Gate off | Routes are not mounted and no provider call occurs when the flag is unset or not `1`. | No; CI/test evidence |
| Capabilities | The authenticated, scoped response lists only configured provider/model capabilities; it does not expose account refs, quota, secret names or usage. | No; CI/test evidence |
| Authz and scope | A missing scoped principal is rejected. A status read outside the persisted channel/subject scope, or for an unknown id, returns the same "not found". | No; CI/test evidence |
| Idempotency | Same scoped key and same body returns the durable request without a second send; a conflicting body returns a conflict. Concurrent duplicates create one request. | No; CI/test evidence |
| Quota | Concurrent distinct submissions cannot overshoot the account quota; settlement uses provider usage; a no-send failure releases the reservation. | No; CI/test evidence |
| Provider failure | A missing secret or endpoint fails closed; a post-dispatch failure becomes `uncertain` and stays reserved without automatic retry. | No; CI/test evidence |
| Redaction | Client and error state carry stable codes only (`provider_transport_failed`, `provider_unknown`, `provider_not_configured`); provider exception text, keys, URLs, prompts and response bodies are absent from rows and logs. | No; CI/test evidence plus a log scan |
| Migration and recovery | Migration `0411` applies cleanly once in staging; operator reconciliation leaves no unexplained active reservation. | Staging: operator |
| Real provider round trip | One authorized request per configured provider, then a duplicate replay and a forced or observed failure; provider billing and ledger usage reconcile. | Yes; not run |
| Retention | Confirm the approved retention policy for request, result and attempt rows and backups; test restore and redaction/access controls. There is no automatic pool-chat purge. | Yes; not run |

## 3. Release decision

The feature stays off until every non-live row has CI or staging evidence and
an authorized operator has recorded the live rows. Without that record, report
the state as "implementation and CI verified; live-pool acceptance pending",
never as live-qualified.
