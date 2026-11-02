# LiteLLM v1.104.1 streaming cost overlay

> Russian version: [litellm-streaming-cost-overlay.ru.md](litellm-streaming-cost-overlay.ru.md)

This runbook describes the production overlay for the LiteLLM v1.104.1 gateway. It fixes a
specific accounting failure: streaming responses from Experiential or `hosted_vllm` can report
`usage.cost = 0.0` even when the deployment has configured custom model prices.

## Scope and image pin

The overlay is for the LiteLLM image running on the `vm-core` gateway:

- image: `ghcr.io/berriai/litellm:v1.104.1@sha256:501909ec...`;
- upstream tag: `v1.104.1`;
- upstream commit: `48963be81b8a1844e09a7769c940bc25d5c66d54`.

The abbreviated digest above is copied from the deployment overlay README. Use the complete
production digest from the deployment configuration when mounting files; do not substitute a
different LiteLLM version without rebuilding and testing the corresponding overlay.

## What is mounted

The overlay replaces these complete modules in the LiteLLM virtual environment inside the
container:

- `litellm/main.py` → `/app/.venv/lib/python3.13/site-packages/litellm/main.py`;
- `litellm/litellm_core_utils/litellm_logging.py` →
  `/app/.venv/lib/python3.13/site-packages/litellm/litellm_core_utils/litellm_logging.py`.

Mount both files from `litellm/patches/1.104.1/`. Mounting only one module leaves the streaming
calculation and spend-log path inconsistent.

## Defect and expected behavior

The provider chunk can contain a numeric `usage.cost` of `0.0`. In unmodified LiteLLM v1.104.1,
that value is treated as authoritative, so the streaming builder and logging path skip the
configured custom price. Non-streaming calls can still record the expected amount, which makes
the defect easy to miss.

With the overlay, when custom pricing is active and the provider reports zero, LiteLLM computes
the cost from the configured token prices:

`prompt_tokens × input_price + completion_tokens × output_price`

The calculated value is written to `usage.cost`, passed as `response_cost`, and then recorded in
`LiteLLM_SpendLogs.spend`. A genuine non-zero provider cost and deployments without custom pricing
retain their normal behavior. The overlay does not invent a price when no configured custom price
applies.

## Operational deployment

1. Confirm that the gateway is running the pinned LiteLLM v1.104.1 image.
2. Copy or mount both overlay modules at the paths above during the planned gateway restart.
3. Do not mount the removed historical backfill script or any `1.108.0` overlay directory.
4. Restart the gateway in the approved maintenance window.
5. Confirm the container is healthy and send a representative streaming request for a deployment
   with known custom input and output prices.
6. Keep the request identifier and token counts for the verification record, but never put API
   keys or their values in logs or the task comment.

The overlay changes runtime calculation only. Historical rows are not recalculated: by decision
of 26 October and ADM confirmation on 30 October, no backfill is performed.

## Streaming cost verification

The repository test suite is the first check after changing the overlay:

```bash
python3 litellm/patches/1.104.1/tests/test_stream_spend_cost.py
# or
python3 -m unittest discover -s litellm/patches/1.104.1/tests -v
```

The test must load the overlay files by path and pass all seven tests. It covers:

1. direct import of both overlay modules;
2. detection of zero-cost streaming responses when custom pricing is enabled;
3. replacement of `usage.cost` with the token-price calculation;
4. bypass of a zero `hidden_params["response_cost"]` for custom-priced models;
5. end-to-end persistence of a positive `tokens × price` value in `SpendLogs.spend`.

For the live smoke check, use a model with a known non-zero configured price and a small streaming
request. Verify all of the following in the same request window:

- the stream completes normally;
- prompt and completion token usage is present;
- provider `usage.cost` may be `0.0`, but the calculated response cost is positive;
- the matching `LiteLLM_SpendLogs` row has `spend > 0` and equals the configured token-price
  calculation, subject to the gateway's normal precision;
- a repeated request does not create a duplicate accounting row for the same request id.

If the row is zero, first check that the request used the mounted v1.104.1 files and that the
model deployment actually has custom pricing. If either check fails, the result does not verify
the overlay. If both pass, stop further traffic, save the request id and sanitized logs, and
escalate the gateway deployment.

## Rollback

If the gateway becomes unhealthy or the smoke check fails, remove the overlay mounts and restore
the previously approved LiteLLM image/configuration through the normal gateway rollback procedure.
Do not edit historical spend rows as part of rollback. Record the image digest, overlay revision,
request id, and observed spend value for the incident.
