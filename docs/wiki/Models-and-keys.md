# Models and budgets

> Русская версия: [Models-and-keys.ru](Models-and-keys.ru)

Every agent run costs tokens. Myrmidon makes the cost accountable: the
company registers the model providers it trusts, the board owns the spend
limits, and the LLM gateway enforces them.

## Model providers

A company registers the model providers its agents may use: OpenAI,
DashScope, Google, or any OpenAI-compatible endpoint. The board holds the
provider credential — the key is written to the company secret store once
and is never returned by any endpoint; reads answer only `has_key`. A model
cache keeps the per-provider model list, and each agent's card picks its
model from the registered providers.

## Budgets and enforcement

Spend limits live on the board as budget policies over scopes (a company, a
project, an agent). The LLM gateway (LiteLLM) enforces them: every limit
saved on the board is projected into the gateway's own budgets — per-key and
per-tag — without restarting anything, within about a minute.

What a crossed limit does is a policy choice (the enforcement mode), not a
single hardcoded behaviour: signal the owner, soft-pause the scope, or
refuse new work. When a hard stop interrupts work, the owner gets a signal
in every interrupted task's thread — the cause, the limit, the observed
spend and how to continue — instead of a silent stop.

## Where the tokens go

The agent card answers two questions about the last run's prompt: which
part of it dominates, and what to do about it. A static advisor computes a
concrete recommendation for every part whose share crosses a threshold, and
a "Deep analysis" button files a task for a cheap-model optimizer agent that
proposes instruction edits as a comment for a human to accept.

## Run admission

The server can bound how many runs it starts at once, how fast it starts
them and how much free memory it keeps (`MYRMIDON_MAX_CONCURRENT_RUNS`,
`MYRMIDON_MIN_FREE_MEMORY_MB` and relatives). Since release 1.3 these
limits are changeable at runtime from the UI or the API, without restarting
the server and without interrupting runs already in flight.

## An empty gateway model catalog signals itself

The spend collection sweep refreshes the gateway's model catalog
(`/v1/model/info`) on every pass. A successful pass that returns 0 models
raises one attention card per company — "Gateway model catalog is empty",
severity high — instead of leaving an empty catalog to fail silently. The
usual cause is the accounting key (`MYRMIDON_LITELLM_KEY_SECRET`) created
with a restricted model list: the gateway answers an empty list on a
perfectly successful request, and everything that reads the catalog
(prices, model lists, entry limits) quietly stops working. The card is
deduped — repeated empty passes keep the same card, the first pass that
sees a non-empty catalog clears it, and the pass right after server start
records the same way, so a misconfigured key surfaces immediately. The fix
is operational: re-create the accounting key with an empty model list (all
models visible) and access to `/spend/logs/v2` and `/v1/model/info`. See
[SETTINGS.md](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/SETTINGS.md),
`MYRMIDON_LITELLM_KEY_SECRET`.

## In detail

- [Company model providers](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/guides/model-providers.md)
- [Budget enforcement modes](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/guides/budget-enforcement.md)
- [LiteLLM budget projection](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/guides/litellm-budget-projection.md)
- [Prompt budget advice and deep analysis](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/guides/prompt-budget-advice.md)
- [Run admission limits](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/guides/run-limits.md)
- [LLM tracing health](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/guides/tracing-health.md)
