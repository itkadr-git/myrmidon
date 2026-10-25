// myrmidon(SETTINGS-UI E2.3): instance-scoped bot/container and fleet credentials that become
// secret-ref settings. Per-agent credentials (card env, GitHub/Git tokens a named dev bot may
// carry, MYRMIDON_API_KEY, MYRMIDON_MCP_TOKEN_<BOT_NAME>) are NOT instance settings: they are
// company secrets bound to the agent and resolved per agent. Their disposition is in
// docs/myrmidon/e2-secret-coverage-1.6.6.md.

import type { InstanceSecretSettingDescriptor } from "./registry.js";

export const BOT_EGRESS_POLICY_CONSUMER = "bot-egress-policy";
export const BOT_EGRESS_REFUSALS_CONSUMER = "bot-egress-refusals";
export const BOT_DISK_DOCKERGATE_CONSUMER = "bot-disk-dockergate";

export const BOT_EGRESS_TOKEN_SETTING = "bot.egress.proxy_token";
export const DOCKERGATE_TOKEN_SETTING = "bot.disk.dockergate_token";

export const BOT_FLEET_SECRET_SETTINGS: readonly InstanceSecretSettingDescriptor[] = [
  {
    name: BOT_EGRESS_TOKEN_SETTING,
    envOverride: "MYRMIDON_BOT_EGRESS_TOKEN",
    description: "Shared token the bot egress proxy presents to the board and the board presents to the proxy",
    consumers: [BOT_EGRESS_POLICY_CONSUMER, BOT_EGRESS_REFUSALS_CONSUMER],
  },
  {
    name: DOCKERGATE_TOKEN_SETTING,
    envOverride: "MYRMIDON_DOCKERGATE_TOKEN",
    description: "Board-to-dockergate token for the physical bot disk view",
    consumers: [BOT_DISK_DOCKERGATE_CONSUMER],
  },
];
