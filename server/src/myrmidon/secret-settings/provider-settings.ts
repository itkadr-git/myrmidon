// myrmidon(SETTINGS-UI E2.2): instance-scoped provider credentials that become secret-ref
// settings. Per-agent adapter credentials (ANTHROPIC_*, CLAUDE_CODE_OAUTH_TOKEN, GEMINI_*,
// GOOGLE_API_KEY, KIMI_MODEL_API_KEY, CURSOR_API_KEY, CODEX_API_KEY, XAI_API_KEY, OPENCLAW_TOKEN and
// the agent's OPENAI_API_KEY) are NOT instance settings: they live in each agent's
// adapterConfig.env as a `secret_ref` binding resolved per agent and company. Their
// disposition is in docs/myrmidon/e2-secret-coverage-1.6.6.md.

import type { InstanceSecretSettingDescriptor } from "./registry.js";

export const CODEX_MODEL_DISCOVERY_CONSUMER = "codex-model-discovery";
export const OPENAI_DISCOVERY_SETTING = "provider.openai.model_discovery_api_key";

export const PROVIDER_SECRET_SETTINGS: readonly InstanceSecretSettingDescriptor[] = [
  {
    name: OPENAI_DISCOVERY_SETTING,
    envOverride: "OPENAI_API_KEY",
    description:
      "OpenAI key the board uses to list available Codex models (instance-wide, not an agent credential)",
    consumers: [CODEX_MODEL_DISCOVERY_CONSUMER],
  },
];
