# Live LiteLLM model catalog

The agent model list for `hermes_gateway`, `hermes_local`, and `omp_local`
uses the LiteLLM `/v1/models` endpoint. A successful response is authoritative,
including an empty list. `PAPERCLIP_ADAPTER_MODELS` is an outage fallback only.
The server writes a warning when it uses that fallback. Upstream exception
messages and secret values are not included in this warning.

The server resolves `MYRMIDON_LITELLM_KEY_SECRET` and
`MYRMIDON_LITELLM_ADMIN_KEY_SECRET` as company secret names through
`secretService`. These variables must not contain bearer credentials.
Existing direct key variables retain their precedence. The model-list route
and agent PATCH validation pass the company and database context to the same
catalog reader. Successful catalogs are cached separately for each company
and base URL for 15 seconds.

The open agent card requests a forced catalog refresh every 10 seconds while
its model configuration is visible. No environment change or server restart
is required when an operator adds a model to LiteLLM. Network latency and
upstream availability still apply. Forced refresh bypasses the server cache.

## Verification

`server/src/__tests__/gateway-model-secrets.test.ts` checks both secret-name
settings, company separation, and cache expiry at 15 seconds.
`server/src/__tests__/adapter-models.test.ts` checks live precedence, empty
responses, outage fallback, warning emission, and forced refresh.
`server/src/__tests__/adapter-pool-models-behavior.test.ts` checks GET and PATCH
for all three adapters when a model exists only in the live response.

After deployment, ADM must check that the agent card lists
`chatgpt-pool/gpt-6-astra` and that PATCH with this model returns 200.
This production check is not a pre-deployment test result.
