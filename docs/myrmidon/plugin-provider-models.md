# Plugin provider models

A plugin manifest may declare `providerModels` with a stable Myrmidon provider
alias, an endpoint, a company-owned credential secret, and model IDs. Enabling
the plugin synchronizes each declared model without restarting Myrmidon.

The model shown to the board and agent key allowlists keeps the manifest alias,
for example `chatgpt-pool/gpt-4o`. The LiteLLM route uses the mapped upstream
provider ID (`openai/gpt-4o` for ChatGPT Pool and `gemini/<id>` for Google AI
Gemini). This keeps the board-facing selector stable while ensuring the first
request is routed by LiteLLM.

On disable, only models owned by that plugin are removed. Shared models remain
registered, and all agent key allowlists are reconciled without rotating the
keys. Repeated enable events are safe: registration and allowlist updates are
idempotent.

Required settings:

- `MYRMIDON_LITELLM_BASE_URL` points at the gateway.
- `MYRMIDON_LITELLM_ADMIN_KEY_SECRET` names the company-owned admin secret.
- The manifest `credentialSecretName` must resolve to a secret owned by the same
  company.

For a production smoke test, install the plugin into a clean instance, enable
it, select a `chatgpt-pool/*` or `google-ai-gemini/*` model, and make a first
request. Verify the request is not rejected with 403, then disable the plugin
and verify its models disappear while models shared by another enabled plugin
remain available.
